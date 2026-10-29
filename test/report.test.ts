import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { recordSpend } from "../src/guard";
import { Registry } from "../src/registry";
import { sinceFromHours, writeAudit, writeDailyReport } from "../src/report";

let root: string;
let home: string;
let repo: string;
let db: Database;
let registry: Registry;

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function commit(cwd: string, file: string, content: string, message: string): string {
	writeFileSync(join(cwd, file), content);
	git(cwd, ["add", file]);
	git(cwd, ["commit", "-qm", message]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-report-"));
	home = join(root, "teams");
	repo = join(root, "repo");
	mkdirSync(home, { recursive: true });
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "r@example.com"]);
	git(repo, ["config", "user.name", "r"]);
	commit(repo, "README.md", "# repo\n", "init");
	db = openDb(home);
	registry = new Registry(db);
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

function team(): { worktree: string; branch: string; head: string } {
	const worktree = join(root, "wt", "feat-x");
	git(repo, ["worktree", "add", "-q", worktree, "-b", "teams/feat-x"]);
	const head = commit(worktree, "colors.txt", "red\ngreen\nblue\n", "add colors");
	registry.upsertProject("p-1", "repo", repo);
	registry.upsertGroup({ projectId: "p-1", name: "feat-x", worktree, branch: "teams/feat-x", base: "main" });
	return { worktree, branch: "teams/feat-x", head };
}

describe("daily report", () => {
	test("lists branches with head and changed files, blockers, spend, drill-down and a merge command", () => {
		const { head } = team();
		registry.register({ role: "personal", cwd: root, sessionId: "01a18300-1111-7000-8000-000000000001" });
		db.run(
			`INSERT INTO tasks (id, project_id, group_name, from_agent, to_agent, title, body, kind, difficulty, model, status, created_at, updated_at)
			 VALUES ('T-1', 'p-1', 'feat-x', 'a-x', 'a-y', 'add colors', 'body', 'feature', 'simple', 'm', 'blocked', ?, ?)`,
			[1_000, 2_000],
		);
		db.run(
			`INSERT INTO messages (id, from_agent, from_seat, to_seat, to_agent, kind, wake, body, created_at)
			 VALUES ('m-1', 'a-y', 'worker:s-1', 'group:p-1/feat-x', 'a-z', 'report', 1, ?, 3_000)`,
			[JSON.stringify({ status: "blocked", summary: "cannot reach the registry", task_id: "T-1" })],
		);
		db.run("UPDATE messages SET task_id = 'T-1' WHERE id = 'm-1'");
		recordSpend(db, { sessionId: "01a18300-1111-7000-8000-000000000001", agentId: "a-1", seat: "personal", model: "x", cost: 1.25, at: Date.now() });

		const report = writeDailyReport({
			db,
			home,
			now: Date.now(),
			budgetUsd: 200,
			spendUsd: 1.25,
			haltReason: null,
			projectRoot: (id) => (id ? registry.projectRoot(id) : null),
		});
		expect(existsSync(report.path)).toBe(true);
		expect(report.path.startsWith(join(home, "reports"))).toBe(true);
		const text = readFileSync(report.path, "utf8");
		expect(text).toContain("| repo | feat-x | `teams/feat-x` |");
		expect(text).toContain(head.slice(0, 12));
		expect(text).toContain("A colors.txt");
		expect(text).toContain("cannot reach the registry");
		expect(text).toContain("$1.25 / $200.00");
		expect(text).toContain(`git -C ${repo} merge --no-ff teams/feat-x`);
		expect(text).toContain("omp -r 01a18300-1111");
		expect(text).toContain("| 0 | 1 |");
	});

	test("an empty team still yields a readable report", () => {
		const report = writeDailyReport({
			db,
			home,
			now: Date.now(),
			budgetUsd: 200,
			spendUsd: 0,
			haltReason: "halted by a human",
			projectRoot: () => null,
		});
		const text = readFileSync(report.path, "utf8");
		expect(text).toContain("没有待合并的分支");
		expect(text).toContain("无记录");
		expect(text).toContain("已停止：halted by a human");
	});
});

describe("audit export", () => {
	test("writes the recent history as JSON with row counts", () => {
		const { head } = team();
		registry.register({ role: "personal", cwd: root, sessionId: "01a18300-2222-7000-8000-000000000002" });
		db.run("INSERT INTO events (at, agent_id, kind, detail) VALUES (?, NULL, 'test', '{}')", [Date.now()]);
		const now = Date.now();
		const audit = writeAudit({ db, home, now, since: sinceFromHours(24, now) });
		expect(existsSync(audit.path)).toBe(true);
		const parsed = JSON.parse(readFileSync(audit.path, "utf8")) as {
			groups: { branch: string }[];
			agents: { seat: string }[];
			events: { kind: string }[];
		};
		expect(audit.counts.groups).toBe(1);
		expect(audit.counts.agents).toBe(1);
		expect(parsed.groups[0]?.branch).toBe("teams/feat-x");
		expect(parsed.events.some((row) => row.kind === "test")).toBe(true);
		expect(head.length).toBe(40);
	});

	test("rows older than the window are left out", () => {
		const now = Date.now();
		db.run(
			`INSERT INTO tasks (id, project_id, group_name, from_agent, to_agent, title, body, kind, difficulty, model, status, created_at, updated_at)
			 VALUES ('T-old', 'p-1', 'g', 'a', NULL, 'old', 'b', 'fix', 'simple', null, 'done', ?, ?)`,
			[now - 48 * 60 * 60_000, now - 48 * 60 * 60_000],
		);
		db.run(
			`INSERT INTO tasks (id, project_id, group_name, from_agent, to_agent, title, body, kind, difficulty, model, status, created_at, updated_at)
			 VALUES ('T-new', 'p-1', 'g', 'a', NULL, 'new', 'b', 'fix', 'simple', null, 'done', ?, ?)`,
			[now, now],
		);
		const audit = writeAudit({ db, home, now, since: sinceFromHours(24, now) });
		const parsed = JSON.parse(readFileSync(audit.path, "utf8")) as { tasks: { id: string }[] };
		expect(parsed.tasks.map((row) => row.id)).toEqual(["T-new"]);
	});
});
