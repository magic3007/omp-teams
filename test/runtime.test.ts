import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { TeamsRuntime } from "../src/runtime";
import { sessionTag } from "../src/identity";
import { buildTeamTree, treeText } from "../src/tree";

let home: string;
let db: Database;
let runtime: TeamsRuntime;
let clock: number;
let worktree: string;

const PROJECT = { id: "p-1", name: "repo", root: "/repo" };

function chain() {
	const personal = runtime.register({ role: "personal", cwd: "/home/x", sessionId: "s-personal" });
	const project = runtime.register(
		{
			role: "project",
			cwd: "/repo",
			sessionId: "s-project",
			projectId: PROJECT.id,
			projectName: PROJECT.name,
		},
		{ project: PROJECT },
	);
	const group = runtime.register(
		{
			role: "group",
			cwd: "/repo",
			sessionId: "s-group",
			projectId: PROJECT.id,
			projectName: PROJECT.name,
			group: "feat-x",
		},
		{ project: PROJECT, group: { worktree: "/wt/feat-x", branch: "teams/feat-x" } },
	);
	const worker = runtime.register(
		{
			role: "worker",
			cwd: worktree,
			sessionId: "s-worker",
			projectId: PROJECT.id,
			projectName: PROJECT.name,
			group: "feat-x",
		},
		{ project: PROJECT },
	);
	for (const result of [personal, project, group, worker]) {
		if (!result.ok) throw new Error(result.error);
	}
	if (!group.ok || !worker.ok) throw new Error("unreachable");
	return { group: group.agent, worker: worker.agent };
}

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-teams-rt-"));
	worktree = mkdtempSync(join(tmpdir(), "omp-teams-wt-"));
	git(worktree, ["init", "-q", "-b", "main"]);
	git(worktree, ["config", "user.email", "t@example.com"]);
	git(worktree, ["config", "user.name", "t"]);
	writeFileSync(join(worktree, "file.txt"), "one\n");
	git(worktree, ["add", "."]);
	git(worktree, ["commit", "-qm", "init"]);
	db = openDb(home);
	clock = 5_000_000;
	runtime = new TeamsRuntime({ db, home, now: () => clock, deadAfterMs: 30_000 });
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	rmSync(worktree, { recursive: true, force: true });
});

describe("assignment", () => {
	test("a manager assigns to a direct subordinate and the task lands in its inbox", () => {
		const { group, worker } = chain();
		const result = runtime.assign(group, {
			to: "worker 1",
			task: "fix the tokenizer overflow",
			kind: "fix",
			difficulty: "normal",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.to?.id).toBe(worker.id);
		expect(result.model).toBe("deepseek/deepseek-v4-flash");

		const task = runtime.taskById(result.taskId);
		expect(task?.status).toBe("assigned");
		expect(task?.to_agent).toBe(worker.id);
		expect(task?.kind).toBe("fix");

		const inbox = runtime.takeInbox(worker);
		expect(inbox.length).toBe(1);
		expect(inbox[0]?.kind).toBe("task");
		expect(inbox[0]?.wake).toBe(1);
	});

	test("cross-level assignment is refused with the allowed targets", () => {
		const { worker } = chain();
		const project = runtime.registry.bySeat("project:p-1");
		if (!project) throw new Error("no project manager");

		const result = runtime.assign(project, {
			to: "worker 1",
			task: "do it directly",
			kind: "fix",
			difficulty: "simple",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("direct subordinates");
		expect(worker.label).toBe("☆ worker 1 · feat-x");
	});

	test("workers cannot assign", () => {
		const { worker } = chain();
		const result = runtime.assign(worker, { to: "worker 1", task: "self", kind: "fix", difficulty: "simple" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("only managers assign");
	});

	test("an explicit model outside the allow list is refused before any task is created", () => {
		const { group } = chain();
		const result = runtime.assign(group, {
			to: "worker 1",
			task: "x",
			kind: "fix",
			difficulty: "simple",
			model: "unknown/expensive",
		});
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("models.allowed");
		expect(db.query("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 0 });
	});
});

describe("reporting", () => {
	test("a done report closes the task, records the sha and wakes the manager", () => {
		const { group, worker } = chain();
		const assigned = runtime.assign(group, {
			to: "worker 1",
			task: "fix it",
			kind: "fix",
			difficulty: "normal",
		});
		if (!assigned.ok) throw new Error(assigned.error);

		const head = git(worktree, ["rev-parse", "HEAD"]);
		const report = runtime.report(worker, {
			summary: "committed",
			status: "done",
			taskId: assigned.taskId,
			sha: head.slice(0, 8),
		});
		expect(report.ok).toBe(true);
		if (!report.ok) throw new Error(report.error);
		expect(report.to.id).toBe(group.id);

		const task = runtime.taskById(assigned.taskId);
		expect(task?.status).toBe("done");
		expect(task?.sha).toBe(git(worktree, ["rev-parse", "HEAD"]).slice(0, 8));

		const inbox = runtime.takeInbox(group);
		expect(inbox[0]?.kind).toBe("report");
		expect(inbox[0]?.wake).toBe(1);
	});

	test("an invented SHA is refused", () => {
		const { group, worker } = chain();
		const assigned = runtime.assign(group, { to: "worker 1", task: "fix it", kind: "fix", difficulty: "normal" });
		if (!assigned.ok) throw new Error(assigned.error);
		const report = runtime.report(worker, {
			summary: "done",
			status: "done",
			taskId: assigned.taskId,
			sha: "deadbeefcafe",
		});
		expect(report.ok).toBe(false);
		if (report.ok) throw new Error("unreachable");
		expect(report.error).toContain("is not a commit");
		expect(runtime.taskById(assigned.taskId)?.status).toBe("assigned");
	});

	test("a progress report does not wake the manager", () => {
		const { group, worker } = chain();
		const assigned = runtime.assign(group, { to: "worker 1", task: "fix it", kind: "fix", difficulty: "normal" });
		if (!assigned.ok) throw new Error(assigned.error);
		const report = runtime.report(worker, {
			summary: "still working",
			status: "progress",
			taskId: assigned.taskId,
		});
		expect(report.ok).toBe(true);
		expect(runtime.takeInbox(group)[0]?.wake).toBe(0);
		expect(runtime.taskById(assigned.taskId)?.status).toBe("assigned");
	});

	test("a report against someone else's task is refused", () => {
		const { group, worker } = chain();
		const other = runtime.register(
			{
				role: "worker",
				cwd: "/wt/feat-x/w2",
				sessionId: "s-worker-2",
				projectId: PROJECT.id,
				projectName: PROJECT.name,
				group: "feat-x",
			},
			{ project: PROJECT },
		);
		if (!other.ok) throw new Error(other.error);

		const assigned = runtime.assign(group, { to: other.agent.id, task: "theirs", kind: "fix", difficulty: "simple" });
		if (!assigned.ok) throw new Error(assigned.error);

		const stolen = runtime.report(worker, { summary: "x", status: "done", taskId: assigned.taskId });
		expect(stolen.ok).toBe(false);
		if (stolen.ok) throw new Error("unreachable");
		expect(stolen.error).toContain("not assigned to");
	});

	test("the personal manager has nobody to report to", () => {
		chain();
		const personal = runtime.registry.bySeat("personal");
		if (!personal) throw new Error("no personal manager");
		const result = runtime.report(personal, { summary: "x", status: "progress" });
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("no manager to report to");
	});
});

describe("progress", () => {
	test("reads the latest report per subordinate without touching them", () => {
		const { group, worker } = chain();
		runtime.report(worker, { summary: "first step done", status: "progress" });
		runtime.report(worker, { summary: "blocked on schema", status: "blocked" });

		const entries = runtime.progress(group);
		expect(entries.length).toBe(1);
		expect(entries[0]?.agent.id).toBe(worker.id);
		expect(entries[0]?.lastReport?.status).toBe("blocked");
		expect(entries[0]?.lastReport?.summary).toBe("blocked on schema");
	});

	test("a manager with no subordinates returns nothing", () => {
		const { worker } = chain();
		expect(runtime.progress(worker)).toEqual([]);
	});
});

describe("tree and departures", () => {
	test("the tree shows each level with its rank and every member's session id", () => {
		const { group, worker } = chain();
		const lines = treeText(buildTeamTree(runtime, null));
		expect(lines).toEqual([
			"★★★ personal leader  ⏳ idle  session s-personal",
			"└─ ★★ repo leader · repo  ⏳ idle  session s-project",
			"   └─ ★ group leader · feat-x  ⏳ idle  session s-group",
			"      └─ ☆ worker 1 · feat-x  ⏳ idle  session s-worker",
		]);
		const below = treeText(buildTeamTree(runtime, group), { selfId: group.id });
		expect(below[0]).toContain("★ group leader · feat-x (you)");
		expect(below).toHaveLength(2);
		expect(below[1]).toContain(`session ${worker.session_id}`);
	});

	test("session tags tell apart members started in the same minute and stay resumable prefixes", () => {
		const lead = "01a18300-3589-7000-a61a-7762cdd79a6c";
		const w1 = "01a18300-4cfe-7000-9662-049ded4d6b62";
		const w2 = "01a18300-4cfe-7000-8641-38f59a1e6b43";
		const pool = [lead, w1, w2];
		expect(sessionTag(lead, pool)).toBe("01a18300-3589");
		expect(sessionTag(w1, pool)).toBe("01a18300-4cfe-7000-9");
		expect(sessionTag(w2, pool)).toBe("01a18300-4cfe-7000-8");
		for (const id of pool) {
			expect(id.startsWith(sessionTag(id, pool))).toBe(true);
			expect(pool.filter((other) => other.startsWith(sessionTag(id, pool)))).toEqual([id]);
		}
		expect(sessionTag("s-1", ["s-1", "s-12"])).toBe("s-1");
	});

	test("a member that leaves frees its seat", () => {
		const { group } = chain();
		runtime.leave(group);
		expect(runtime.registry.bySeat("group:p-1/feat-x")).toBeNull();
		const retaken = runtime.register({
			role: "group",
			cwd: "/repo",
			sessionId: "s-group-2",
			projectId: PROJECT.id,
			projectName: PROJECT.name,
			group: "feat-x",
		});
		expect(retaken.ok).toBe(true);
	});
});
