import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { mergeIntoGroup } from "../src/merge";
import { type MailRow, mailBody as parseMailBody } from "../src/mail";
import { TaskQueue } from "../src/queue";
import type { AgentRow } from "../src/registry";
import { CLOSE_GRACE_MS, NO_OPEN_TASK, TeamsRuntime } from "../src/runtime";

let root: string;
let home: string;
let repo: string;
let db: Database;
let clock: number;
let runtime: TeamsRuntime;

const DEAD_AFTER = 30_000;

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function commitFile(cwd: string, file: string, content: string, message: string): string {
	writeFileSync(join(cwd, file), content);
	git(cwd, ["add", file]);
	git(cwd, ["commit", "-qm", message]);
	return git(cwd, ["rev-parse", "HEAD"]);
}

interface Team {
	project: AgentRow;
	group: AgentRow;
	w1: AgentRow;
	w2: AgentRow;
	integrator: AgentRow;
	groupWorktree: string;
	w1Worktree: string;
	w2Worktree: string;
}

/** personal -> project -> group feat-x -> w1, w2 + integrator, with real worktrees. */
function team(options: { verify?: string } = {}): Team {
	const project = { id: "p-1", name: "repo", root: repo };
	if (options.verify !== undefined) {
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "teams.yml"), `merge:\n  verify_command: ${JSON.stringify(options.verify)}\n`);
		runtime.invalidateConfig();
	}
	const groupWorktree = join(root, "wt", "feat-x", "group");
	const w1Worktree = join(root, "wt", "feat-x", "w1");
	const w2Worktree = join(root, "wt", "feat-x", "w2");
	git(repo, ["worktree", "add", "-q", groupWorktree, "-b", "teams/feat-x"]);
	git(groupWorktree, ["worktree", "add", "-q", w1Worktree, "-b", "teams-w/feat-x/w1", "teams/feat-x"]);
	git(groupWorktree, ["worktree", "add", "-q", w2Worktree, "-b", "teams-w/feat-x/w2", "teams/feat-x"]);

	const must = <T extends { ok: boolean }>(result: T): T => {
		if (!result.ok) throw new Error(JSON.stringify(result));
		return result;
	};
	must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
	const projectLead = must(
		runtime.register(
			{ role: "project", cwd: repo, sessionId: "s-project", projectId: project.id, projectName: project.name },
			{ project },
		),
	);
	const groupLead = must(
		runtime.register(
			{
				role: "group",
				cwd: groupWorktree,
				sessionId: "s-group",
				projectId: project.id,
				projectName: project.name,
				group: "feat-x",
			},
			{ project, group: { worktree: groupWorktree, branch: "teams/feat-x" } },
		),
	);
	const integratorSlot = runtime.slots.ensure({
		projectId: project.id,
		group: "feat-x",
		kind: "integrator",
		index: 1,
		worktree: groupWorktree,
		branch: "teams/feat-x",
	});
	const worker = (cwd: string, session: string) =>
		must(
			runtime.register(
				{ role: "worker", cwd, sessionId: session, projectId: project.id, projectName: project.name, group: "feat-x" },
				{ project },
			),
		);
	const w1 = worker(w1Worktree, "s-w1");
	const w2 = worker(w2Worktree, "s-w2");
	const integrator = must(
		runtime.register(
			{
				role: "worker",
				cwd: groupWorktree,
				sessionId: "s-int",
				projectId: project.id,
				projectName: project.name,
				group: "feat-x",
				slotId: integratorSlot.id,
			},
			{ project },
		),
	);
	if (!projectLead.ok || !groupLead.ok || !w1.ok || !w2.ok || !integrator.ok) throw new Error("unreachable");
	return {
		project: projectLead.agent,
		group: groupLead.agent,
		w1: w1.agent,
		w2: w2.agent,
		integrator: integrator.agent,
		groupWorktree,
		w1Worktree,
		w2Worktree,
	};
}

function mailBodyOf(row: MailRow | { body: string }): { status?: string; fresh?: boolean; summary?: string } {
	return parseMailBody(row as MailRow) as { status?: string; fresh?: boolean; summary?: string };
}

function fresh(agent: AgentRow): AgentRow {
	const row = runtime.registry.byId(agent.id);
	if (!row) throw new Error(`agent ${agent.id} vanished`);
	return row;
}

/** Let time pass while every live member keeps its heartbeat (as their poll timers would). */
function advance(ms: number): void {
	clock += ms;
	for (const row of runtime.registry.allAlive()) runtime.registry.heartbeat(row.id);
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-m2-"));
	home = join(root, "teams");
	repo = join(root, "repo");
	mkdirSync(home, { recursive: true });
	mkdirSync(repo, { recursive: true });
	git(repo, ["init", "-q", "-b", "main"]);
	git(repo, ["config", "user.email", "t@example.com"]);
	git(repo, ["config", "user.name", "t"]);
	commitFile(repo, "README.md", "# repo\n", "init");
	db = openDb(home);
	clock = 10_000_000;
	runtime = new TeamsRuntime({ db, home, now: () => clock, deadAfterMs: DEAD_AFTER });
});

afterEach(() => {
	db.close();
	rmSync(root, { recursive: true, force: true });
});

describe("task queue", () => {
	test("two claims never take the same task", () => {
		const queue = new TaskQueue(db, () => clock);
		const scope = { projectId: "p-1", group: "g" };
		for (const body of ["one", "two"]) {
			queue.create({
				projectId: "p-1",
				group: "g",
				fromAgent: "lead",
				fromSeat: "group:p-1/g",
				body,
				kind: "fix",
				difficulty: "simple",
				model: null,
				status: "queued",
			});
		}
		const a = queue.claim(scope, { agentId: "a", slotId: "s-a", seat: "worker:s-a", merge: false });
		const b = queue.claim(scope, { agentId: "b", slotId: "s-b", seat: "worker:s-b", merge: false });
		const c = queue.claim(scope, { agentId: "c", slotId: "s-c", seat: "worker:s-c", merge: false });
		expect(a?.body).toBe("one");
		expect(b?.body).toBe("two");
		expect(c).toBeNull();
	});

	test("merge tasks are invisible to workers and pinned tasks only reach their slot", () => {
		const queue = new TaskQueue(db, () => clock);
		const scope = { projectId: "p-1", group: "g" };
		const base = { projectId: "p-1", group: "g", fromAgent: "lead", fromSeat: "group:p-1/g", difficulty: "simple", model: null };
		queue.create({ ...base, body: "merge it", kind: "merge", status: "queued" });
		queue.create({ ...base, body: "rework for s-a", kind: "fix", status: "queued", pinSlot: "s-a" });

		expect(queue.claim(scope, { agentId: "b", slotId: "s-b", seat: "worker:s-b", merge: false })).toBeNull();
		expect(queue.claim(scope, { agentId: "a", slotId: "s-a", seat: "worker:s-a", merge: false })?.body).toBe("rework for s-a");
		expect(queue.claim(scope, { agentId: "i", slotId: "s-i", seat: "worker:s-i", merge: true })?.body).toBe("merge it");
	});

	test("a failure requeues until the limit, then blocks", () => {
		const queue = new TaskQueue(db, () => clock);
		const task = queue.create({
			projectId: "p-1",
			group: "g",
			fromAgent: "lead",
			fromSeat: "group:p-1/g",
			body: "flaky",
			kind: "fix",
			difficulty: "simple",
			model: null,
			status: "queued",
		});
		const scope = { projectId: "p-1", group: "g" };
		queue.claim(scope, { agentId: "a", slotId: "s-a", seat: "worker:s-a", merge: false });
		expect(queue.fail(task.id, 2)).toEqual({ status: "queued", attempts: 1 });
		const requeued = queue.byId(task.id);
		expect(requeued?.to_agent).toBeNull();
		expect(requeued?.to_seat).toBeNull();

		queue.claim(scope, { agentId: "b", slotId: "s-b", seat: "worker:s-b", merge: false });
		expect(queue.fail(task.id, 2)).toEqual({ status: "blocked", attempts: 2 });
		expect(queue.claim(scope, { agentId: "c", slotId: "s-c", seat: "worker:s-c", merge: false })).toBeNull();
	});
});

describe("merging into the group branch", () => {
	test("a clean worker commit merges with a merge commit", () => {
		const t = team();
		const sha = commitFile(t.w1Worktree, "a.txt", "a\n", "add a");
		const result = mergeIntoGroup(t.groupWorktree, sha, "merge a");
		expect(result.kind).toBe("merged");
		expect(git(t.groupWorktree, ["merge-base", "--is-ancestor", sha, "HEAD"])).toBe("");
		expect(mergeIntoGroup(t.groupWorktree, sha, "again").kind).toBe("already-merged");
	});

	test("a conflict aborts cleanly and names the files", () => {
		const t = team();
		const first = commitFile(t.w1Worktree, "same.txt", "from w1\n", "w1");
		const second = commitFile(t.w2Worktree, "same.txt", "from w2\n", "w2");
		expect(mergeIntoGroup(t.groupWorktree, first, "merge w1").kind).toBe("merged");
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);

		const conflict = mergeIntoGroup(t.groupWorktree, second, "merge w2");
		expect(conflict).toEqual({ kind: "conflict", files: ["same.txt"] });
		expect(git(t.groupWorktree, ["rev-parse", "HEAD"])).toBe(head);
		expect(git(t.groupWorktree, ["status", "--porcelain"])).toBe("");
	});

	test("failed verification reverts the merge", () => {
		const t = team();
		const sha = commitFile(t.w1Worktree, "b.txt", "b\n", "add b");
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);
		const result = mergeIntoGroup(t.groupWorktree, sha, "merge b", { verifyCommand: "echo broken >&2; exit 3" });
		expect(result.kind).toBe("verify-failed");
		if (result.kind === "verify-failed") expect(result.output).toContain("broken");
		expect(git(t.groupWorktree, ["rev-parse", "HEAD"])).toBe(head);
	});
});

describe("claim, report, merge loop", () => {
	test("a queued task is claimed by an idle worker and its done report queues a merge", () => {
		const t = team();
		const queued = runtime.assign(t.group, { task: "add a.txt", kind: "feature", difficulty: "simple" });
		expect(queued.ok && queued.queued).toBe(true);
		if (!queued.ok) throw new Error(queued.error);

		const claimed = runtime.claimNext(t.w1);
		expect(claimed?.id).toBe(queued.taskId);
		expect(runtime.claimNext(t.w2)).toBeNull();
		const mail = runtime.takeInbox(t.w1).find((row) => row.kind === "task");
		expect(mail?.task_id).toBe(queued.taskId);
		runtime.taskDelivered(queued.taskId, t.w1);
		expect(runtime.taskById(queued.taskId)?.status).toBe("running");

		const sha = commitFile(t.w1Worktree, "a.txt", "a\n", "add a");
		const report = runtime.report(t.w1, { taskId: queued.taskId, status: "done", sha, summary: "added" });
		expect(report.ok).toBe(true);
		if (!report.ok) throw new Error(report.error);
		expect(report.followUp).toContain("merge");

		// Only the integrator can see the merge.
		expect(runtime.claimNext(t.w2)).toBeNull();
		const merge = runtime.claimNext(t.integrator);
		expect(merge?.kind).toBe("merge");
		expect(merge?.source_sha).toBe(sha);
		if (!merge) throw new Error("no merge task");
		runtime.taskDelivered(merge.id, t.integrator);

		const outcome = runtime.merge(t.integrator, merge.id);
		expect(outcome.ok).toBe(true);
		expect(runtime.taskById(merge.id)?.status).toBe("done");
		expect(git(t.groupWorktree, ["merge-base", "--is-ancestor", sha, "HEAD"])).toBe("");
	});

	test("a conflicting commit goes back to its author as a pinned rework task", () => {
		const t = team();
		for (const worker of [t.w1, t.w2]) {
			const res = runtime.assign(t.group, { task: `edit same.txt as ${worker.label}`, kind: "fix", difficulty: "simple" });
			if (!res.ok) throw new Error(res.error);
		}
		const first = runtime.claimNext(t.w1);
		const second = runtime.claimNext(t.w2);
		if (!first || !second) throw new Error("claims failed");
		const s1 = commitFile(t.w1Worktree, "same.txt", "w1\n", "w1");
		const s2 = commitFile(t.w2Worktree, "same.txt", "w2\n", "w2");
		runtime.report(t.w1, { taskId: first.id, status: "done", sha: s1, summary: "w1" });
		runtime.report(t.w2, { taskId: second.id, status: "done", sha: s2, summary: "w2" });

		const m1 = runtime.claimNext(t.integrator);
		if (!m1) throw new Error("no first merge");
		expect(runtime.merge(t.integrator, m1.id).ok).toBe(true);
		const m2 = runtime.claimNext(fresh(t.integrator));
		if (!m2) throw new Error("no second merge");
		const outcome = runtime.merge(t.integrator, m2.id);
		expect(outcome.ok && outcome.summary).toContain("sent back");
		expect(runtime.taskById(m2.id)?.status).toBe("failed");

		// The rework only reaches w2, the author of the conflicting commit.
		expect(runtime.claimNext(t.w1)).toBeNull();
		const rework = runtime.claimNext(t.w2);
		expect(rework?.kind).toBe("fix");
		expect(rework?.body).toContain("same.txt");
		expect(rework?.body).toContain("git rebase teams/feat-x");
	});

	test("managers cannot hand out merge work or give work to the integrator", () => {
		const t = team();
		const merge = runtime.assign(t.group, { task: "merge w1", kind: "merge", difficulty: "trivial" });
		expect(merge.ok).toBe(false);
		if (merge.ok) throw new Error("unreachable");
		expect(merge.error).toContain("merges are automatic");
		const toIntegrator = runtime.assign(t.group, { to: t.integrator.label, task: "do x", kind: "fix", difficulty: "simple" });
		expect(toIntegrator.ok).toBe(false);
		if (toIntegrator.ok) throw new Error("unreachable");
		expect(toIntegrator.error).toContain("is the integrator");
	});

	test("a manager's done report with a branch head is not merged again", () => {
		const t = team();
		const parent = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!parent.ok) throw new Error(parent.error);
		runtime.taskDelivered(parent.taskId, t.group);
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);
		const report = runtime.report(t.group, { taskId: parent.taskId, status: "done", sha: head, summary: "branch ready" });
		expect(report.ok).toBe(true);
		expect(runtime.claimNext(t.integrator)).toBeNull();
	});

	test("only the integrator may run a merge", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "x", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		expect(runtime.merge(t.w1, res.taskId)).toEqual({
			ok: false,
			error: `${t.w1.label} is not the group integrator; only the integrator merges.`,
		});
	});

	test("an invented SHA cannot close a task", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "x", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const report = runtime.report(t.w1, { taskId: res.taskId, status: "done", sha: "0123456789abcdef", summary: "x" });
		expect(report.ok).toBe(false);
		expect(runtime.taskById(res.taskId)?.status).toBe("claimed");
	});

	test("a failed report puts the task back for another worker", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "hard thing", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const report = runtime.report(t.w1, { taskId: res.taskId, status: "failed", summary: "could not" });
		expect(report.ok && report.followUp).toContain("returned to the queue");
		expect(runtime.claimNext(t.w2)?.id).toBe(res.taskId);
	});
});

describe("claim gates", () => {
	test("a paused group, a manual pane and a retiring slot do not claim", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "x", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);

		expect(runtime.pause(t.group, "feat-x", true).ok).toBe(true);
		expect(runtime.claimNext(t.w1)).toBeNull();
		runtime.pause(t.group, "feat-x", false);

		runtime.setManual(t.w1, true);
		expect(runtime.claimNext(t.w1)).toBeNull();
		runtime.setManual(t.w1, false);

		const retire = runtime.retire(t.group, t.w2.label);
		expect(retire.ok).toBe(true);
		expect(runtime.claimNext(t.w2)).toBeNull();

		expect(runtime.claimNext(t.w1)?.id).toBe(res.taskId);
	});

	test("a worker with a task in hand does not claim another", () => {
		const t = team();
		for (const body of ["one", "two"]) runtime.assign(t.group, { task: body, kind: "fix", difficulty: "simple" });
		expect(runtime.claimNext(t.w1)?.body).toBe("one");
		expect(runtime.claimNext(t.w1)).toBeNull();
	});

	test("only the worker's own group lead may retire it, and never the integrator", () => {
		const t = team();
		expect(runtime.retire(t.project, t.w1.label).ok).toBe(false);
		expect(runtime.retire(t.w2, t.w1.label).ok).toBe(false);
		const integrator = runtime.retire(t.group, t.integrator.label);
		expect(integrator.ok).toBe(false);
		if (integrator.ok) throw new Error("unreachable");
		expect(integrator.error).toContain("stays as long as the group");
	});
});

describe("patrol", () => {
	test("a task held by a dead worker returns to the queue, then blocks and escalates", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "x", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);

		// w1 stops heartbeating; everyone else keeps going.
		clock += DEAD_AFTER + 1_000;
		for (const agent of [t.group, t.project, t.w2, t.integrator]) runtime.registry.heartbeat(agent.id);
		runtime.registry.heartbeat(runtime.registry.bySeat("personal")?.id ?? "");
		const first = runtime.patrol(fresh(t.group));
		expect(first.requeued).toEqual([res.taskId]);
		expect(runtime.taskById(res.taskId)?.status).toBe("queued");

		runtime.claimNext(t.w2);
		clock += DEAD_AFTER + 1_000;
		for (const agent of [t.group, t.project, t.integrator]) runtime.registry.heartbeat(agent.id);
		runtime.registry.heartbeat(runtime.registry.bySeat("personal")?.id ?? "");
		const second = runtime.patrol(fresh(t.group));
		expect(second.blocked).toEqual([res.taskId]);
		expect(second.escalated).toEqual([res.taskId]);
		const toProject = runtime.takeInbox(t.project).find((row) => row.kind === "report");
		expect(toProject?.body).toContain("needs a decision");
		expect(toProject?.wake).toBe(1);
	});

	test("a new holder of a seat inherits the open task of the dead one", () => {
		const t = team();
		const res = runtime.assign(t.group, { to: t.w1.label, task: "direct", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.taskDelivered(res.taskId, t.w1);

		// The launcher restarted w1 in the same pane with a fresh session.
		const respawn = runtime.register(
			{
				role: "worker",
				cwd: t.w1Worktree,
				sessionId: "s-w1-b",
				projectId: "p-1",
				projectName: "repo",
				group: "feat-x",
				slotId: runtime.slotOf(t.w1)?.id,
				force: true,
			},
			{},
		);
		expect(respawn.ok).toBe(true);
		if (!respawn.ok) throw new Error(respawn.error);
		expect(respawn.agent.seat).toBe(t.w1.seat);

		const inherited = runtime.inheritOpenTasks(respawn.agent);
		expect(inherited.map((task) => task.id)).toEqual([res.taskId]);
		expect(runtime.taskById(res.taskId)?.to_agent).toBe(respawn.agent.id);
		const mail = runtime.takeInbox(respawn.agent).filter((row) => row.task_id === res.taskId);
		expect(mail.length).toBeGreaterThanOrEqual(1);
	});

	test("a running task with no report past the stall limit is escalated once", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "slow", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		runtime.taskDelivered(res.taskId, t.w1);

		const stall = runtime.configOf(t.group).stall_minutes * 60_000;
		clock += stall + 1_000;
		for (const agent of [t.group, t.project, t.w1, t.w2, t.integrator]) runtime.registry.heartbeat(agent.id);
		runtime.registry.heartbeat(runtime.registry.bySeat("personal")?.id ?? "");
		expect(runtime.patrol(fresh(t.group)).stalled).toEqual([res.taskId]);
		expect(runtime.patrol(fresh(t.group)).stalled).toEqual([]);
		const notice = runtime.takeInbox(t.group).find((row) => row.kind === "notice");
		expect(notice?.body).toContain("without a report");
	});

	test("when every issued task is done the group closes its own task with the branch head", () => {
		const t = team();
		const parent = runtime.assign(t.project, { to: t.group.label, task: "build feature", kind: "feature", difficulty: "normal" });
		if (!parent.ok) throw new Error(parent.error);
		runtime.taskDelivered(parent.taskId, t.group);

		const child = runtime.assign(t.group, { task: "part 1", kind: "feature", difficulty: "simple" });
		if (!child.ok) throw new Error(child.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "p1.txt", "1\n", "part 1");
		runtime.report(t.w1, { taskId: child.taskId, status: "done", sha, summary: "done" });
		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		runtime.merge(t.integrator, merge.id);

		// Finished work closes the task only after the grace period, not at once.
		expect(runtime.patrol(fresh(t.group)).drained).toBe(false);
		advance(CLOSE_GRACE_MS);
		const result = runtime.patrol(fresh(t.group));
		expect(result.drained).toBe(true);
		const closed = runtime.taskById(parent.taskId);
		expect(closed?.status).toBe("done");
		expect(closed?.sha).toBe(git(t.groupWorktree, ["rev-parse", "HEAD"]));
	});
});

describe("work traces back to a request", () => {
	test("a lead without an open task cannot start model-driven work; with one, children link to it", () => {
		const t = team();
		const refused = runtime.assign(t.group, { task: "self-started", kind: "fix", difficulty: "simple", requireOpenTask: true });
		expect(refused).toEqual({ ok: false, error: NO_OPEN_TASK });

		const parent = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!parent.ok) throw new Error(parent.error);
		runtime.taskDelivered(parent.taskId, t.group);
		const child = runtime.assign(t.group, { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		expect(child.ok).toBe(true);
		if (!child.ok) throw new Error(child.error);
		expect(runtime.taskById(child.taskId)?.parent_task).toBe(parent.taskId);
	});

	test("once the drained task is closed, the lead cannot start follow-ups on its own", () => {
		const t = team();
		const parent = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!parent.ok) throw new Error(parent.error);
		runtime.taskDelivered(parent.taskId, t.group);
		const child = runtime.assign(t.group, { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!child.ok) throw new Error(child.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "part.txt", "p\n", "part");
		runtime.report(t.w1, { taskId: child.taskId, status: "done", sha, summary: "done" });
		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		runtime.merge(t.integrator, merge.id);
		advance(CLOSE_GRACE_MS);
		expect(runtime.patrol(fresh(t.group)).drained).toBe(true);

		const followUp = runtime.assign(fresh(t.group), { task: "one more thing", kind: "fix", difficulty: "simple", requireOpenTask: true });
		expect(followUp).toEqual({ ok: false, error: NO_OPEN_TASK });
	});

	test("an unrelated finished task does not close the lead's current task", () => {
		const t = team();
		const first = runtime.assign(t.project, { to: t.group.label, task: "first slice", kind: "feature", difficulty: "normal" });
		if (!first.ok) throw new Error(first.error);
		runtime.taskDelivered(first.taskId, t.group);
		// Nothing has been delegated for this task yet: it must stay open.
		expect(runtime.patrol(fresh(t.group)).drained).toBe(false);
		expect(runtime.taskById(first.taskId)?.status).toBe("running");
	});
});

describe("group branch integrity", () => {
	test("a branch moved outside the integrator stops merges until a human accepts the head", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "a", kind: "feature", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "a.txt", "a\n", "a");
		runtime.report(t.w1, { taskId: res.taskId, status: "done", sha, summary: "a" });

		// Someone rewrites the group branch behind the integrator's back.
		commitFile(t.groupWorktree, "rogue.txt", "x\n", "rogue");

		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		const blocked = runtime.merge(t.integrator, merge.id);
		expect(blocked.ok && blocked.summary).toContain("moved outside the integrator");
		expect(runtime.taskById(merge.id)?.status).toBe("blocked");

		const accepted = runtime.acceptHead(t.group, "feat-x");
		expect(accepted.ok).toBe(true);
		expect(runtime.taskById(merge.id)?.status).toBe("queued");
		const retry = runtime.claimNext(fresh(t.integrator));
		if (!retry) throw new Error("merge was not re-queued");
		const merged = runtime.merge(t.integrator, retry.id);
		expect(merged.ok && merged.summary).toContain("is in teams/feat-x");
	});
});

describe("done means done", () => {
	test("closing a task cancels the open work under it and tells the holders", () => {
		const t = team();
		const personal = runtime.registry.bySeat("personal");
		if (!personal) throw new Error("no personal");
		const top = runtime.assign(personal, { to: t.project.label, task: "build it", kind: "feature", difficulty: "normal" });
		if (!top.ok) throw new Error(top.error);
		runtime.taskDelivered(top.taskId, t.project);
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal", requireOpenTask: true });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		const part = runtime.assign(t.group, { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!part.ok) throw new Error(part.error);
		runtime.claimNext(t.w1);
		runtime.taskDelivered(part.taskId, t.w1);

		// The project lead declares the request done while its group is still working.
		const report = runtime.report(t.project, { taskId: top.taskId, status: "done", summary: "good enough" });
		expect(report.ok && report.followUp).toContain("2 open task(s)");
		expect(runtime.taskById(slice.taskId)?.status).toBe("cancelled");
		expect(runtime.taskById(part.taskId)?.status).toBe("cancelled");

		const workerCancel = runtime.takeInbox(t.w1).find((row) => row.kind === "cancel");
		expect(workerCancel?.body).toContain(part.taskId);
		expect(runtime.takeInbox(t.group).some((row) => row.kind === "cancel")).toBe(true);

		// The lead has nothing open, so it cannot invent follow-ups; the worker cannot close a cancelled task.
		expect(runtime.assign(fresh(t.group), { task: "polish", kind: "fix", difficulty: "simple", requireOpenTask: true })).toEqual({
			ok: false,
			error: NO_OPEN_TASK,
		});
		const late = runtime.report(t.w1, { taskId: part.taskId, status: "done", summary: "finished anyway" });
		expect(late.ok).toBe(false);
		if (late.ok) throw new Error("unreachable");
		expect(late.error).toContain("closed upstream");
	});

	test("a commit the group branch already contains is not merged again", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "verify", kind: "test", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		// The worker reports the group head it verified, which the group branch already has.
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);
		git(t.w1Worktree, ["reset", "-q", "--hard", head]);
		const report = runtime.report(t.w1, { taskId: res.taskId, status: "done", sha: head, summary: "verified" });
		expect(report.ok).toBe(true);
		expect(runtime.claimNext(t.integrator)).toBeNull();
	});
});

describe("leaders lead", () => {
	test("tasks to leaders carry no model; work for workers is routed", () => {
		const t = team();
		const toLead = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "simple" });
		if (!toLead.ok) throw new Error(toLead.error);
		expect(toLead.model).toBeNull();
		expect(runtime.taskById(toLead.taskId)?.model).toBeNull();

		const queued = runtime.assign(t.group, { task: "part", kind: "feature", difficulty: "simple" });
		if (!queued.ok) throw new Error(queued.error);
		expect(queued.model).toBe("deepseek/deepseek-v4-flash");
	});

	test("a leader that reported blocked continues the same task once answered", () => {
		const t = team();
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		runtime.report(t.group, { taskId: slice.taskId, status: "blocked", summary: "which file format?" });
		expect(runtime.taskById(slice.taskId)?.status).toBe("blocked");

		// The answer arrives by teams_ask; the lead delegates under the same task, which runs again.
		const part = runtime.assign(fresh(t.group), { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!part.ok) throw new Error(part.error);
		expect(runtime.taskById(part.taskId)?.parent_task).toBe(slice.taskId);
		expect(runtime.taskById(slice.taskId)?.status).toBe("running");
	});

	test("a progress report continues a blocked task, and a later block escalates again", () => {
		const t = team();
		const res = runtime.assign(t.group, { to: t.w1.label, task: "direct", kind: "fix", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.taskDelivered(res.taskId, t.w1);
		runtime.report(t.w1, { taskId: res.taskId, status: "blocked", summary: "question" });
		expect(runtime.patrol(fresh(t.group)).escalated).toEqual([res.taskId]);

		runtime.report(t.w1, { taskId: res.taskId, status: "progress", summary: "answered, continuing" });
		expect(runtime.taskById(res.taskId)?.status).toBe("running");
		runtime.report(t.w1, { taskId: res.taskId, status: "blocked", summary: "another question" });
		expect(runtime.patrol(fresh(t.group)).escalated).toEqual([res.taskId]);
	});

	test("a second done report on a closed task changes nothing", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "a", kind: "feature", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "a.txt", "a\n", "a");
		runtime.report(t.w1, { taskId: res.taskId, status: "done", sha, summary: "a" });
		runtime.report(t.w1, { taskId: res.taskId, status: "done", sha, summary: "a, again" });
		expect(runtime.slotOf(t.w1)?.tasks_done).toBe(1);
		expect(runtime.queue.list({ projectId: "p-1", group: "feat-x" }).filter((task) => task.kind === "merge")).toHaveLength(1);
	});

	test("the repo leader's automatic close names each delivered branch, its head and the files it changes", () => {
		const t = team();
		const personal = runtime.registry.bySeat("personal");
		if (!personal) throw new Error("no personal");
		const top = runtime.assign(personal, { to: t.project.label, task: "build it", kind: "feature", difficulty: "normal" });
		if (!top.ok) throw new Error(top.error);
		runtime.taskDelivered(top.taskId, t.project);
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal", requireOpenTask: true });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		const part = runtime.assign(t.group, { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!part.ok) throw new Error(part.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "part.txt", "p\n", "part");
		runtime.report(t.w1, { taskId: part.taskId, status: "done", sha, summary: "done" });
		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		runtime.merge(t.integrator, merge.id);

		advance(CLOSE_GRACE_MS);
		expect(runtime.patrol(fresh(t.group)).drained).toBe(true);
		// The repo leader's own work (the group's task) just finished: it waits out its grace too.
		advance(CLOSE_GRACE_MS);
		expect(runtime.patrol(fresh(t.project)).drained).toBe(true);
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);
		const closing = runtime.takeInbox(personal).find((row) => row.kind === "report" && row.task_id === top.taskId);
		expect(closing?.body).toContain(`- teams/feat-x at ${head}; changes against main: A part.txt`);
		expect(runtime.taskById(top.taskId)?.status).toBe("done");
	});

	test("a leader holding several tasks names the one new work serves, and each closes on its own work", () => {
		const t = team();
		const first = runtime.assign(t.project, { to: t.group.label, task: "slice one", kind: "feature", difficulty: "simple" });
		const second = runtime.assign(t.project, { to: t.group.label, task: "slice two", kind: "feature", difficulty: "simple" });
		if (!first.ok || !second.ok) throw new Error("assign failed");
		runtime.taskDelivered(first.taskId, t.group);
		runtime.taskDelivered(second.taskId, t.group);

		const ambiguous = runtime.assign(fresh(t.group), { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		expect(ambiguous.ok).toBe(false);
		if (ambiguous.ok) throw new Error("unreachable");
		expect(ambiguous.error).toContain("Pass parent_task");
		expect(ambiguous.error).toContain(first.taskId);
		const foreign = runtime.assign(fresh(t.group), {
			task: "part",
			kind: "feature",
			difficulty: "simple",
			requireOpenTask: true,
			parentTask: "T-nope",
		});
		expect(foreign.ok).toBe(false);

		// Work for the older task only: it closes, the newer one stays open.
		const part = runtime.assign(fresh(t.group), {
			task: "part of slice one",
			kind: "feature",
			difficulty: "simple",
			requireOpenTask: true,
			parentTask: first.taskId,
		});
		if (!part.ok) throw new Error(part.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "one.txt", "1\n", "one");
		runtime.report(t.w1, { taskId: part.taskId, status: "done", sha, summary: "one" });
		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		runtime.merge(t.integrator, merge.id);

		advance(CLOSE_GRACE_MS);
		expect(runtime.patrol(fresh(t.group)).drained).toBe(true);
		expect(runtime.taskById(first.taskId)?.status).toBe("done");
		expect(runtime.taskById(second.taskId)?.status).toBe("running");
	});
});

describe("status counts", () => {
	test("the integrator is not counted as a worker", () => {
		const t = team();
		// w1, w2 and the integrator are alive in group feat-x.
		expect(runtime.counts(t.group).workers).toBe(2);
		expect(runtime.counts(t.project).workers).toBe(2);
	});
});

describe("review fixes", () => {
	test("a lead that keeps delegating under its task is not reported as stalled", () => {
		const t = team();
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		const stall = runtime.configOf(t.project).stall_minutes * 60_000;
		advance(stall - 60_000);
		const part = runtime.assign(fresh(t.group), { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!part.ok) throw new Error(part.error);
		advance(120_000);
		expect(runtime.patrol(fresh(t.project)).stalled).toEqual([]);
	});

	test("a worker cannot report a commit from another worker's branch", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "a", kind: "feature", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const foreign = commitFile(t.w2Worktree, "w2.txt", "2\n", "w2 work");
		const report = runtime.report(t.w1, { taskId: res.taskId, status: "done", sha: foreign, summary: "done" });
		expect(report.ok).toBe(false);
		if (report.ok) throw new Error("unreachable");
		expect(report.error).toContain("not on your branch");
		const own = commitFile(t.w1Worktree, "w1.txt", "1\n", "w1 work");
		expect(runtime.report(t.w1, { taskId: res.taskId, status: "done", sha: own, summary: "done" }).ok).toBe(true);
	});

	test("without an integrator the done report says the commit still needs merging", () => {
		const t = team();
		// As with `auto_integrator: false`: the group has no integrator slot at all.
		db.run("DELETE FROM slots WHERE kind = 'integrator'");
		const res = runtime.assign(t.group, { task: "a", kind: "feature", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "a.txt", "a\n", "a");
		const report = runtime.report(t.w1, { taskId: res.taskId, status: "done", sha, summary: "done" });
		expect(report.ok && report.followUp).toContain("has no integrator; merge it by hand");
	});
});

describe("evidence on every leader done report", () => {
	test("a group leader that reports done itself still sends the system-checked branch, head and files", () => {
		const t = team();
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		const part = runtime.assign(fresh(t.group), { task: "part", kind: "feature", difficulty: "simple", requireOpenTask: true });
		if (!part.ok) throw new Error(part.error);
		runtime.claimNext(t.w1);
		const sha = commitFile(t.w1Worktree, "p.txt", "p\n", "p");
		runtime.report(t.w1, { taskId: part.taskId, status: "done", sha, summary: "done" });
		const merge = runtime.claimNext(t.integrator);
		if (!merge) throw new Error("no merge");
		runtime.merge(t.integrator, merge.id);

		// The lead closes its task by hand, before the automatic close.
		const report = runtime.report(fresh(t.group), { taskId: slice.taskId, status: "done", summary: "all good" });
		expect(report.ok).toBe(true);
		const head = git(t.groupWorktree, ["rev-parse", "HEAD"]);
		const delivered = runtime.takeInbox(t.project).find((row) => row.kind === "report" && row.task_id === slice.taskId);
		expect(delivered?.body).toContain("all good");
		expect(delivered?.body).toContain(`Delivered (checked by the system):\\n- teams/feat-x at ${head}; changes against main: A p.txt`);
	});
});

describe("brakes", () => {
	test("halt pauses every group, refuses new work, and the integrator still merges", () => {
		const t = team();
		const res = runtime.assign(t.group, { task: "queued before halt", kind: "feature", difficulty: "simple" });
		if (!res.ok) throw new Error(res.error);
		const before = runtime.registry.bySeat("personal");
		if (!before) throw new Error("no personal");
		const halted = runtime.halt(before, "test halt");
		expect(halted.paused).toBeGreaterThanOrEqual(1);
		expect(runtime.registry.group("p-1", "feat-x")?.paused).toBe(1);
		expect(runtime.registry.group("p-1", "feat-x")?.paused_reason).toBe("halt");

		// Workers stop claiming, merging keeps working, leaders cannot assign.
		expect(runtime.claimNext(t.w1)).toBeNull();
		expect(runtime.assign(fresh(t.project), { to: t.group.label, task: "nope", kind: "fix", difficulty: "simple" })).toEqual({
			ok: false,
			error: "new work cannot start: the team is halted: test halt.",
		});
		expect(runtime.takeInbox(t.group).some((row) => row.kind === "notice")).toBe(true);

		const resumed = runtime.resume(before);
		expect(resumed.resumed).toBeGreaterThanOrEqual(1);
		expect(runtime.registry.group("p-1", "feat-x")?.paused).toBe(0);
		expect(runtime.assign(fresh(t.project), { to: t.group.label, task: "again", kind: "fix", difficulty: "simple" }).ok).toBe(true);
	});

	test("a human pause survives a halt and a resume: only brake pauses are lifted", () => {
		const t = team();
		const personal = runtime.registry.bySeat("personal");
		if (!personal) throw new Error("no personal");
		runtime.pause(personal, "feat-x", true);
		runtime.halt(personal, "halt test");
		// The human pause is not relabelled as a brake pause.
		expect(runtime.registry.group("p-1", "feat-x")?.paused_reason).toBeNull();
		runtime.resume(personal);
		expect(runtime.registry.group("p-1", "feat-x")?.paused).toBe(1);
		expect(runtime.registry.group("p-1", "feat-x")?.paused_reason).toBeNull();
	});

	test("the budget brake pauses every group once the day's spend reaches the limit", () => {
		const t = team();
		const personal = runtime.registry.bySeat("personal");
		if (!personal) throw new Error("no personal");
		// A one-cent budget in the machine config: any reported spend trips it.
		writeFileSync(join(home, "config.yml"), "guards:\n  budget:\n    daily_usd: 0.01\n");
		runtime.invalidateConfig();
		runtime.recordUsage(personal, 0.02);

		expect(runtime.guard(personal).frozen).toBe(true);
		runtime.patrol(fresh(t.project));
		expect(runtime.registry.group("p-1", "feat-x")?.paused_reason).toBe("budget");
		expect(runtime.claimNext(t.w1)).toBeNull();
		const refused = runtime.assign(fresh(t.project), { to: t.group.label, task: "x", kind: "fix", difficulty: "simple" });
		expect(refused.ok).toBe(false);
		if (refused.ok) throw new Error("unreachable");
		expect(refused.error).toContain("daily budget is spent");
	});

	test("a group that keeps producing blockers is paused and escalated", () => {
		const t = team();
		mkdirSync(join(repo, ".omp"), { recursive: true });
		writeFileSync(join(repo, ".omp", "teams.yml"), "guards:\n  group_blocked_per_hour: 1\n");
		runtime.invalidateConfig();
		const slice = runtime.assign(t.project, { to: t.group.label, task: "slice", kind: "feature", difficulty: "normal" });
		if (!slice.ok) throw new Error(slice.error);
		runtime.taskDelivered(slice.taskId, t.group);
		runtime.report(fresh(t.group), { taskId: slice.taskId, status: "blocked", summary: "cannot decide" });

		const result = runtime.patrol(fresh(t.group));
		expect(result.guards).toEqual(["blocked-rate:feat-x"]);
		expect(runtime.registry.group("p-1", "feat-x")?.paused_reason).toBe("blocked-rate");
		const escalation = runtime.takeInbox(t.project).filter((row) => row.kind === "report" && mailBodyOf(row).status === "blocked");
		expect(escalation.some((row) => (mailBodyOf(row).summary ?? "").includes("blocked report(s) in the last hour"))).toBe(true);
	});

	test("fresh status requests are rate limited per manager", () => {
		const t = team();
		const first = runtime.requestFreshStatus(fresh(t.group));
		expect(first.ok && first.asked.length).toBe(3);
		const second = runtime.requestFreshStatus(fresh(t.group));
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("unreachable");
		expect(second.error).toContain("wait");
		// The ping carries the fresh flag so the receiver runs an ephemeral turn.
		const ping = runtime.takeInbox(t.w1).find((row) => row.kind === "ping");
		expect(mailBodyOf(ping ?? { body: "{}" })).toMatchObject({ fresh: true });
	});
});
