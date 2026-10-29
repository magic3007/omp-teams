import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { type ProjectIdentity, resolveProject } from "../src/identity";
import type { AgentRow, RegisterResult } from "../src/registry";
import { TeamsRuntime } from "../src/runtime";
import { launchFiles, launcherScript, seatLaunchFiles } from "../src/spawn";

let root: string;
let home: string;
let repo: string;
let db: Database;
let runtime: TeamsRuntime;
let project: ProjectIdentity;

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function must(result: RegisterResult): AgentRow {
	if (!result.ok) throw new Error(result.error);
	return result.agent;
}

interface Tree {
	personal: AgentRow;
	lead: AgentRow;
	group: AgentRow;
	worker: AgentRow;
	integrator: AgentRow;
}

function tree(): Tree {
	const personal = must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
	const lead = must(
		runtime.register(
			{ role: "project", cwd: repo, sessionId: "s-project", projectId: project.id, projectName: project.name },
			{ project },
		),
	);
	const group = must(
		runtime.register(
			{ role: "group", cwd: repo, sessionId: "s-group", projectId: project.id, projectName: project.name, group: "docs" },
			{ project, group: { worktree: repo, branch: "teams/docs" } },
		),
	);
	const workerSlot = runtime.slots.ensure({ projectId: project.id, group: "docs", kind: "worker", index: 1, worktree: join(root, "w1"), branch: "teams-w/docs/w1" });
	const worker = must(
		runtime.register(
			{ role: "worker", cwd: join(root, "w1"), sessionId: "s-w1", projectId: project.id, projectName: project.name, group: "docs", slotId: workerSlot.id },
			{ project },
		),
	);
	const integratorSlot = runtime.slots.ensure({ projectId: project.id, group: "docs", kind: "integrator", index: 1, worktree: repo, branch: "teams/docs" });
	const integrator = must(
		runtime.register(
			{ role: "worker", cwd: repo, sessionId: "s-int", projectId: project.id, projectName: project.name, group: "docs", slotId: integratorSlot.id },
			{ project },
		),
	);
	return { personal, lead, group, worker, integrator };
}

function statusOf(agent: AgentRow): string | undefined {
	return runtime.registry.byId(agent.id)?.status;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-close-"));
	home = join(root, "teams");
	const code = join(root, "code");
	repo = join(code, "app");
	mkdirSync(home, { recursive: true });
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "t@example.com"]);
	git(repo, ["config", "user.name", "t"]);
	writeFileSync(join(repo, "README.md"), "# app\n");
	git(repo, ["add", "README.md"]);
	git(repo, ["commit", "-qm", "init"]);
	writeFileSync(
		join(home, "config.yml"),
		[`worktree_root: ${join(root, "wt")}`, "repos:", "  roots:", `    - ${code}`, "  depth: 2", ""].join("\n"),
	);
	const identity = resolveProject(repo);
	if (!identity) throw new Error("the test repository is not a git repository");
	project = identity;
	db = openDb(home);
	runtime = new TeamsRuntime({ db, home });
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("closing a subtree", () => {
	test("the personal leader closes a repo leader by repository name, with everyone below it", () => {
		const t = tree();
		const closed = runtime.close(t.personal, "app");
		if (!closed.ok) throw new Error(closed.error);

		expect(closed.closed.map((row) => row.id).sort()).toEqual([t.lead.id, t.group.id, t.worker.id, t.integrator.id].sort());
		for (const agent of [t.lead, t.group, t.worker, t.integrator]) expect(statusOf(agent)).toBe("left");
		expect(statusOf(t.personal)).toBe("alive");
		expect(runtime.registry.childrenOf(t.personal.seat)).toEqual([]);
		for (const slot of runtime.slots.all()) expect(slot.status).toBe("retired");
	});

	test("every open task in the subtree is cancelled, including the one sent to the closed leader", () => {
		const t = tree();
		const toLead = runtime.assign(t.personal, { to: t.lead.id, task: "Write docs", kind: "docs", difficulty: "simple" });
		if (!toLead.ok) throw new Error(toLead.error);
		const toGroup = runtime.assign(t.lead, { to: t.group.id, task: "Write docs", kind: "docs", difficulty: "simple" });
		if (!toGroup.ok) throw new Error(toGroup.error);
		const queued = runtime.assign(t.group, { task: "Write docs", kind: "docs", difficulty: "simple" });
		if (!queued.ok) throw new Error(queued.error);

		const closed = runtime.close(t.personal, t.lead.label);
		if (!closed.ok) throw new Error(closed.error);

		expect(closed.cancelled.sort()).toEqual([toLead.taskId, toGroup.taskId, queued.taskId].sort());
		for (const id of closed.cancelled) expect(runtime.taskById(id)?.status).toBe("cancelled");
	});

	test("mail waiting for a closed seat is dropped, so a new holder of the seat starts clean", () => {
		const t = tree();
		runtime.ask(t.personal, t.lead.id, "status?");
		expect(runtime.takeInbox(t.lead)).toHaveLength(1);

		const closed = runtime.close(t.personal, t.lead.id);
		if (!closed.ok) throw new Error(closed.error);
		expect(runtime.takeInbox(t.lead)).toHaveLength(0);
	});

	test("the launcher of every closed seat gets its stop file, and a parked seat is woken to read it", () => {
		const t = tree();
		expect(runtime.park(t.group).ok).toBe(true);

		const closed = runtime.close(t.personal, t.lead.id);
		if (!closed.ok) throw new Error(closed.error);

		for (const agent of [t.lead, t.group, t.worker, t.integrator]) {
			expect(existsSync(seatLaunchFiles(home, agent.seat).stop)).toBe(true);
		}
		expect(existsSync(seatLaunchFiles(home, t.group.seat).wake)).toBe(true);
		expect(existsSync(seatLaunchFiles(home, t.lead.seat).wake)).toBe(false);
	});

	test("a group leader closes one worker and leaves the rest of the group alone", () => {
		const t = tree();
		const closed = runtime.close(t.group, t.worker.label);
		if (!closed.ok) throw new Error(closed.error);
		expect(closed.closed.map((row) => row.id)).toEqual([t.worker.id]);
		expect(statusOf(t.worker)).toBe("left");
		expect(statusOf(t.integrator)).toBe("alive");
		expect(statusOf(t.group)).toBe("alive");
	});

	test("only a direct subordinate can be closed", () => {
		const t = tree();
		const deeper = runtime.close(t.personal, t.group.id);
		expect(deeper.ok).toBe(false);
		const upward = runtime.close(t.lead, "parent");
		expect(upward.ok).toBe(false);
		const fromWorker = runtime.close(t.worker, t.integrator.id);
		expect(fromWorker.ok).toBe(false);
		for (const agent of [t.lead, t.group, t.worker, t.integrator]) expect(statusOf(agent)).toBe("alive");
	});

	test("a repository without a repo leader has nothing to close", () => {
		const personal = must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
		const closed = runtime.close(personal, "app");
		expect(closed.ok).toBe(false);
	});

	test("a closed group comes back with a working integrator slot", () => {
		const t = tree();
		const closed = runtime.close(t.lead, t.group.id);
		if (!closed.ok) throw new Error(closed.error);
		expect(runtime.slots.integratorFor(project.id, "docs")).toBeNull();
		const again = runtime.slots.ensure({ projectId: project.id, group: "docs", kind: "integrator", index: 1, worktree: repo, branch: "teams/docs" });
		expect(again.status).toBe("free");
	});
});

interface Launcher {
	proc: Bun.Subprocess;
	output: () => string;
	argv: () => string[];
}

function fakeOmp(bin: string): void {
	mkdirSync(bin, { recursive: true });
	const script = [
		"#!/bin/sh",
		'printf "%s\\n" "$*" >> "$ARGV_FILE"',
		'if [ -n "$PARK_ON_RUN" ]; then printf "%s" "$SESSION_FILE" > "$OMP_TEAMS_PARK"; fi',
		'sleep "${FAKE_SLEEP:-1}"',
	].join("\n");
	writeFileSync(join(bin, "omp"), `${script}\n`);
	chmodSync(join(bin, "omp"), 0o755);
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(50);
	}
	return false;
}

describe("the launcher of a closed parked seat", () => {
	test("exits on its stop file instead of resuming the session", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		mkdirSync(join(home, "launch"), { recursive: true });
		const files = launchFiles(home, "project-p-1");
		const script = join(root, "launcher.sh");
		writeFileSync(script, launcherScript({ home, tag: "project-p-1", cwd: root, join: "role=project", model: "m" }));
		const proc = Bun.spawn(["sh", script], {
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ARGV_FILE: argvFile, SESSION_FILE: join(root, "s.jsonl"), PARK_ON_RUN: "1", FAKE_SLEEP: "0" },
			stdout: "pipe",
			stderr: "pipe",
		});
		let text = "";
		void (async () => {
			for await (const chunk of proc.stdout) text += Buffer.from(chunk).toString();
		})();
		const launcher: Launcher = {
			proc,
			output: () => text,
			argv: () => (existsSync(argvFile) ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean) : []),
		};
		try {
			expect(await waitUntil(() => launcher.output().includes("parked; waiting for work"), 15_000)).toBe(true);
			writeFileSync(files.stop, "1\n");
			expect(await waitUntil(() => launcher.output().includes("member stopped"), 15_000)).toBe(true);
			expect(await launcher.proc.exited).toBe(0);
			expect(launcher.argv()).toHaveLength(1);
		} finally {
			launcher.proc.kill();
		}
	}, 40_000);
});
