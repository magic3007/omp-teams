import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { Herdr } from "../src/herdr";
import { type ProjectIdentity, resolveProject } from "../src/identity";
import { mailBody } from "../src/mail";
import type { AgentRow, RegisterResult } from "../src/registry";
import { assignWork, forwardTask, type RouteDeps } from "../src/route";
import { CLOSE_GRACE_MS, TeamsRuntime } from "../src/runtime";
import { seatLaunchFiles } from "../src/spawn";

let root: string;
let home: string;
let repo: string;
let db: Database;
let clock: number;
let runtime: TeamsRuntime;
let project: ProjectIdentity;
let previousHerdr: string | undefined;
let sessions: number;

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function must(result: RegisterResult): AgentRow {
	if (!result.ok) throw new Error(result.error);
	return result.agent;
}

function leaders(): { personal: AgentRow; lead: AgentRow } {
	const personal = must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
	const lead = must(
		runtime.register(
			{ role: "project", cwd: repo, sessionId: "s-project", projectId: project.id, projectName: project.name },
			{ project },
		),
	);
	runtime.registry.setProjectWorkspace(project.id, "w1");
	return { personal, lead };
}

function deps(): RouteDeps {
	return {
		runtime,
		spawn: { runtime, herdr: new Herdr(), home, config: runtime.configFor(repo) },
		awaitMember: async (seat) => {
			const slot = runtime.slots.byId(seat.slice("worker:".length));
			if (!slot) return null;
			sessions++;
			return must(
				runtime.register({
					role: "worker",
					cwd: slot.worktree,
					sessionId: `s-analyst-${sessions}`,
					projectId: project.id,
					projectName: project.name,
					slotId: slot.id,
				}),
			);
		},
	};
}

async function analysisFor(personal: AgentRow, lead: AgentRow, question: string): Promise<{ held: string; analyst: AgentRow; taskId: string }> {
	const assigned = await assignWork(deps(), personal, { to: lead.id, task: question, kind: "analysis", difficulty: "simple" });
	if (!assigned.ok) throw new Error(assigned.error);
	const forwarded = await forwardTask(deps(), lead, { taskId: assigned.taskId });
	if (!forwarded.ok) throw new Error(forwarded.error);
	if (!forwarded.to) throw new Error("no analyst");
	return { held: assigned.taskId, analyst: forwarded.to, taskId: forwarded.taskId };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-analyst-"));
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

	const stub = join(root, "herdr");
	const script = [
		"#!/bin/sh",
		'key="$1 $2"',
		'case "$key" in',
		'  "tab create") printf \'%s\' \'{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9","tab_id":"w1:t9","workspace_id":"w1","cwd":"/repo"}}}\' ;;',
		'  "pane split") printf \'%s\' \'{"result":{"pane":{"pane_id":"w1:p10","tab_id":"w1:t9","workspace_id":"w1","cwd":"/repo"}}}\' ;;',
		"  \"pane run\"|\"pane rename\") printf '%s' '{\"result\":{\"type\":\"ok\"}}' ;;",
		"  *) printf '%s' '{\"error\":{\"code\":\"unknown\",\"message\":\"no stub\"}}' ;;",
		"esac",
	].join("\n");
	writeFileSync(stub, `${script}\n`);
	chmodSync(stub, 0o755);
	previousHerdr = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;

	clock = 1_000_000;
	sessions = 0;
	db = openDb(home);
	runtime = new TeamsRuntime({ db, home, now: () => clock });
});

afterEach(() => {
	db.close();
	if (previousHerdr === undefined) delete process.env.HERDR_BIN_PATH;
	else process.env.HERDR_BIN_PATH = previousHerdr;
	rmSync(root, { recursive: true, force: true });
});

describe("a repo leader forwarding an analysis task", () => {
	test("starts an analyst under itself on a new worktree branch of the current code", async () => {
		const { personal, lead } = leaders();
		const { held, analyst, taskId } = await analysisFor(personal, lead, "Where is the config loaded?");

		expect(analyst.parent_seat).toBe(lead.seat);
		expect(analyst.group_name).toBeNull();
		const slot = runtime.slotOf(analyst);
		expect(slot?.kind).toBe("analyst");
		if (!slot) throw new Error("no slot");
		expect(slot.branch).toStartWith("teams-a/");
		expect(git(slot.worktree, ["rev-parse", "HEAD"])).toBe(git(repo, ["rev-parse", "HEAD"]));
		expect(git(slot.worktree, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(slot.branch);

		const task = runtime.taskById(taskId);
		expect(task?.to_agent).toBe(analyst.id);
		expect(task?.parent_task).toBe(held);
		expect(task?.kind).toBe("analysis");
	});

	test("each analysis gets its own worktree and branch", async () => {
		const { personal, lead } = leaders();
		const first = await analysisFor(personal, lead, "What does the parser do?");
		const second = await analysisFor(personal, lead, "Who calls the parser?");
		const a = runtime.slotOf(first.analyst);
		const b = runtime.slotOf(second.analyst);
		expect(a?.worktree).not.toBe(b?.worktree);
		expect(a?.branch).not.toBe(b?.branch);
	});

	test("a code task without a group is still refused", async () => {
		const { personal, lead } = leaders();
		const assigned = await assignWork(deps(), personal, { to: lead.id, task: "Fix the parser", kind: "fix", difficulty: "simple" });
		if (!assigned.ok) throw new Error(assigned.error);
		const forwarded = await forwardTask(deps(), lead, {});
		expect(forwarded.ok).toBe(false);
	});
});

describe("an analyst", () => {
	test("reports done without a SHA, and its slot retires", async () => {
		const { personal, lead } = leaders();
		const { analyst, taskId } = await analysisFor(personal, lead, "Where is the config loaded?");
		const slot = runtime.slotOf(analyst);
		if (!slot) throw new Error("no slot");

		const reported = runtime.report(analyst, { taskId, status: "done", summary: "src/config.ts loadConfig" });
		if (!reported.ok) throw new Error(reported.error);
		expect(runtime.taskById(taskId)?.status).toBe("done");
		expect(runtime.slots.byId(slot.id)?.status).toBe("retiring");

		runtime.retireSlot(analyst);
		expect(runtime.registry.byId(analyst.id)?.status).toBe("left");
		expect(runtime.slots.byId(slot.id)?.status).toBe("retired");
	});

	test("its launcher deletes the worktree and branch once the analyst stops", async () => {
		const { personal, lead } = leaders();
		const { analyst } = await analysisFor(personal, lead, "Where is the config loaded?");
		const slot = runtime.slotOf(analyst);
		if (!slot) throw new Error("no slot");
		const files = seatLaunchFiles(home, analyst.seat);
		const bin = join(root, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "omp"), `#!/bin/sh\nprintf '1\\n' > '${files.stop}'\n`);
		chmodSync(join(bin, "omp"), 0o755);

		const launcher = Bun.spawn(["sh", files.script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdout: "pipe", stderr: "pipe" });
		expect(await launcher.exited).toBe(0);
		expect(existsSync(slot.worktree)).toBe(false);
		expect(git(repo, ["branch", "--list", slot.branch])).toBe("");
		expect(git(repo, ["worktree", "list"])).not.toContain(slot.worktree);
	});

	test("a failed analysis ends the task and frees the held task for a new forward", async () => {
		const { personal, lead } = leaders();
		const { held, analyst, taskId } = await analysisFor(personal, lead, "Where is the config loaded?");
		const reported = runtime.report(analyst, { taskId, status: "failed", summary: "the code is not there" });
		if (!reported.ok) throw new Error(reported.error);
		expect(runtime.taskById(taskId)?.status).toBe("failed");
		runtime.retireSlot(analyst);

		const again = await forwardTask(deps(), lead, { taskId: held });
		if (!again.ok) throw new Error(again.error);
		expect(again.to?.id).not.toBe(analyst.id);
	});

	test("its answer travels up in the repo leader's done report", async () => {
		const { personal, lead } = leaders();
		const { held, analyst, taskId } = await analysisFor(personal, lead, "Where is the config loaded?");
		runtime.report(analyst, { taskId, status: "done", summary: "loadConfig in src/config.ts reads config.yml" });
		runtime.takeInbox(personal);

		clock += CLOSE_GRACE_MS + 1;
		for (const row of runtime.registry.allAlive()) runtime.registry.heartbeat(row.id);
		runtime.patrol(lead);

		expect(runtime.taskById(held)?.status).toBe("done");
		const report = runtime.takeInbox(personal).find((row) => row.kind === "report" && row.task_id === held);
		expect(report).toBeDefined();
		if (!report) return;
		expect(mailBody(report).summary).toContain("loadConfig in src/config.ts reads config.yml");
	});

	test("an analyst that vanishes fails its task, so the repo leader can forward again", async () => {
		const { personal, lead } = leaders();
		const { held, analyst, taskId } = await analysisFor(personal, lead, "Where is the config loaded?");
		const slot = runtime.slotOf(analyst);
		if (!slot) throw new Error("no slot");

		clock += 60_000;
		runtime.registry.heartbeat(lead.id);
		runtime.registry.heartbeat(personal.id);
		const patrolled = runtime.patrol(lead);

		expect(patrolled.abandoned).toEqual([taskId]);
		expect(runtime.taskById(taskId)?.status).toBe("failed");
		expect(runtime.slots.byId(slot.id)?.status).toBe("retired");
		expect(existsSync(seatLaunchFiles(home, analyst.seat).stop)).toBe(true);
		expect(runtime.forwardable(lead).map((task) => task.id)).toEqual([held]);
	});

	test("closing the repo leader closes its analyst and stops its launcher", async () => {
		const { personal, lead } = leaders();
		const { analyst } = await analysisFor(personal, lead, "Where is the config loaded?");

		const closed = runtime.close(personal, lead.id);
		if (!closed.ok) throw new Error(closed.error);
		expect(closed.closed.map((row) => row.id)).toContain(analyst.id);
		expect(existsSync(seatLaunchFiles(home, analyst.seat).stop)).toBe(true);
	});
});
