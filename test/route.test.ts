import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { Herdr } from "../src/herdr";
import { type ProjectIdentity, resolveProject } from "../src/identity";
import { taskPaths } from "../src/queue";
import type { AgentRow, RegisterResult } from "../src/registry";
import { assignWork, forwardTask, queueWork, type RouteDeps } from "../src/route";
import { NO_OPEN_TASK, TeamsRuntime } from "../src/runtime";

let root: string;
let home: string;
let repo: string;
let db: Database;
let runtime: TeamsRuntime;
let project: ProjectIdentity;
let previousHerdr: string | undefined;

const HERDR_RESPONSES: Record<string, string> = {
	"workspace create": JSON.stringify({
		result: {
			workspace: { workspace_id: "wXX", label: "app" },
			tab: { tab_id: "wXX:t1" },
			root_pane: { pane_id: "wXX:p1", tab_id: "wXX:t1", workspace_id: "wXX", cwd: "/repo" },
		},
	}),
	"tab create": JSON.stringify({
		result: {
			tab: { tab_id: "wXX:t2" },
			root_pane: { pane_id: "wXX:p2", tab_id: "wXX:t2", workspace_id: "wXX", cwd: "/wt" },
		},
	}),
	"pane split": JSON.stringify({ result: { pane: { pane_id: "wXX:p3", tab_id: "wXX:t2", workspace_id: "wXX", cwd: "/wt" } } }),
	"tab rename": JSON.stringify({ result: { type: "ok" } }),
	"workspace rename": JSON.stringify({ result: { type: "ok" } }),
	"pane run": JSON.stringify({ result: { type: "ok" } }),
	"pane rename": JSON.stringify({ result: { type: "ok" } }),
};

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function must(result: RegisterResult): AgentRow {
	if (!result.ok) throw new Error(result.error);
	return result.agent;
}

function deps(started?: (seat: string) => AgentRow): RouteDeps {
	return {
		runtime,
		spawn: { runtime, herdr: new Herdr(), home, config: runtime.configFor(repo) },
		awaitMember: async (seat) => (started ? started(seat) : null),
	};
}

function herdrCalls(): string[] {
	const log = join(root, "herdr-calls.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function personal(): AgentRow {
	return must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
}

function repoLeader(session = "s-project"): AgentRow {
	return must(
		runtime.register(
			{ role: "project", cwd: repo, sessionId: session, projectId: project.id, projectName: project.name },
			{ project },
		),
	);
}

function groupLeader(name: string, session = `s-group-${name}`): AgentRow {
	const worktree = join(root, "wt", project.id, name, "group");
	if (!existsSync(worktree)) git(repo, ["worktree", "add", "-q", worktree, "-b", `teams/${name}`]);
	const lead = must(
		runtime.register(
			{
				role: "group",
				cwd: worktree,
				sessionId: session,
				projectId: project.id,
				projectName: project.name,
				group: name,
			},
			{ project, group: { worktree, branch: `teams/${name}` } },
		),
	);
	runtime.registry.setGroupLayout(project.id, name, { workspaceId: "wXX", tabId: "wXX:t2", leadPaneId: "wXX:p2" });
	return lead;
}

function hold(from: AgentRow, to: AgentRow, body: string): string {
	const assigned = runtime.assign(from, { to: to.id, task: body, kind: "docs", difficulty: "simple" });
	if (!assigned.ok) throw new Error(assigned.error);
	runtime.taskDelivered(assigned.taskId, to);
	return assigned.taskId;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-route-"));
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
		`echo "$@" >> ${join(root, "herdr-calls.log")}`,
		'key="$1 $2"',
		'case "$key" in',
		...Object.entries(HERDR_RESPONSES).map(
			([pattern, response]) => `  "${pattern}") printf '%s' '${response.replace(/'/g, `'\\''`)}' ;;`,
		),
		"  *) printf '%s' '{\"error\":{\"code\":\"unknown\",\"message\":\"no stub\"}}' ;;",
		"esac",
	].join("\n");
	writeFileSync(stub, `${script}\n`);
	chmodSync(stub, 0o755);
	previousHerdr = process.env.HERDR_BIN_PATH;
	process.env.HERDR_BIN_PATH = stub;

	db = openDb(home);
	runtime = new TeamsRuntime({ db, home });
});

afterEach(() => {
	db.close();
	if (previousHerdr === undefined) delete process.env.HERDR_BIN_PATH;
	else process.env.HERDR_BIN_PATH = previousHerdr;
	rmSync(root, { recursive: true, force: true });
});

describe("the personal leader sends a request to its repository", () => {
	test("the request reaches the live repo leader of the repository it names, word for word", async () => {
		const me = personal();
		const lead = repoLeader();
		const routed = await assignWork(deps(), me, { to: "App", task: "Add a CHANGELOG entry.", kind: "docs", difficulty: "trivial" });
		if (!routed.ok) throw new Error(routed.error);
		expect(routed.to?.id).toBe(lead.id);
		expect(routed.started).toBeNull();
		expect(runtime.taskById(routed.taskId)?.body).toBe("Add a CHANGELOG entry.");
		expect(herdrCalls()).toEqual([]);
	});

	test("a repository without a repo leader gets one before the request lands", async () => {
		const me = personal();
		const seats: string[] = [];
		const routed = await assignWork(
			deps((seat) => {
				seats.push(seat);
				return repoLeader("s-project-started");
			}),
			me,
			{ to: "app", task: "Fix the typo in README.", kind: "fix", difficulty: "trivial" },
		);
		if (!routed.ok) throw new Error(routed.error);
		const lead = runtime.registry.bySeat(`project:${project.id}`);
		expect(seats).toEqual([`project:${project.id}`]);
		expect(routed.started).toBe(lead?.label ?? "no repo leader");
		expect(routed.to?.id).toBe(lead?.id ?? "no repo leader");
		expect(runtime.taskById(routed.taskId)?.body).toBe("Fix the typo in README.");
		expect(herdrCalls().some((call) => call.startsWith("workspace create"))).toBe(true);
	});

	test("a request that names no known repository is refused, starts nothing, and goes back to the human", async () => {
		const routed = await assignWork(deps(), personal(), { to: "nope", task: "anything", kind: "fix", difficulty: "trivial" });
		expect(routed.ok).toBe(false);
		if (routed.ok) return;
		expect(routed.error).toContain('no repository named "nope"');
		expect(routed.askHuman).toBe(true);
		expect(herdrCalls()).toEqual([]);
	});

	test("a close name or a path outside any repository is never settled by the router", async () => {
		const me = personal();
		for (const to of ["ap", join(root, "code")]) {
			const routed = await assignWork(deps(), me, { to, task: "anything", kind: "fix", difficulty: "trivial" });
			expect(routed.ok).toBe(false);
			if (routed.ok) return;
			expect(routed.askHuman).toBe(true);
		}
		expect(herdrCalls()).toEqual([]);
		expect(runtime.queue.issuedBy(me.seat, ["assigned", "queued"])).toEqual([]);
	});

	test("an explicit model and paths travel with the request down to the worker task", async () => {
		const me = personal();
		const lead = repoLeader();
		const docs = groupLeader("docs");
		runtime.slots.ensure({
			projectId: project.id,
			group: "docs",
			kind: "worker",
			index: 1,
			worktree: join(root, "wt", project.id, "docs", "w1"),
			branch: "teams-w/docs/w1",
		});
		const sent = await assignWork(deps(), me, {
			to: "app",
			task: "Rewrite the guide.",
			kind: "docs",
			difficulty: "simple",
			model: "deepseek/deepseek-flash",
			paths: ["docs/guide.md"],
		});
		if (!sent.ok) throw new Error(sent.error);
		runtime.taskDelivered(sent.taskId, lead);
		const toGroup = await forwardTask(deps(), lead, { group: "docs" });
		if (!toGroup.ok) throw new Error(toGroup.error);
		runtime.taskDelivered(toGroup.taskId, docs);
		const queued = await forwardTask(deps(), docs, {});
		if (!queued.ok) throw new Error(queued.error);

		for (const id of [sent.taskId, toGroup.taskId, queued.taskId]) {
			const row = runtime.taskById(id);
			if (!row) throw new Error(`task ${id} is missing`);
			expect(row.body).toBe("Rewrite the guide.");
			expect(row.model).toBe("deepseek/deepseek-flash");
			expect(taskPaths(row)).toEqual(["docs/guide.md"]);
		}
		expect(runtime.taskById(queued.taskId)?.status).toBe("queued");
		expect(herdrCalls()).toEqual([]);
	});
});

describe("repo and group leaders forward the task they hold, unchanged", () => {
	test("a repo leader's forward starts the group it names and hands over its task", async () => {
		const me = personal();
		const lead = repoLeader();
		runtime.registry.setProjectWorkspace(project.id, "wXX");
		const held = hold(me, lead, "Document the CLI flags.");
		const routed = await forwardTask(
			deps(() => groupLeader("cli-docs", "s-group-started")),
			lead,
			{ group: "cli-docs" },
		);
		if (!routed.ok) throw new Error(routed.error);
		const docs = runtime.registry.bySeat(`group:${project.id}/cli-docs`);
		if (!docs) throw new Error("the group leader is not registered");
		expect(routed.started).toBe(docs.label);
		expect(routed.to?.id).toBe(docs.id);
		const task = runtime.taskById(routed.taskId);
		expect(task?.body).toBe("Document the CLI flags.");
		expect(task?.kind).toBe("docs");
		expect(task?.parent_task).toBe(held);
		expect(git(repo, ["branch", "--list", "teams/cli-docs"])).toContain("teams/cli-docs");
	});

	test("a group leader's forward queues its task and starts a worker when the group has none", async () => {
		const me = personal();
		const lead = repoLeader();
		const docs = groupLeader("docs");
		hold(me, lead, "Write the FAQ.");
		const forwarded = await forwardTask(deps(), lead, { group: "docs" });
		if (!forwarded.ok) throw new Error(forwarded.error);
		runtime.taskDelivered(forwarded.taskId, docs);

		const routed = await forwardTask(deps(), docs, {});
		if (!routed.ok) throw new Error(routed.error);
		expect(routed.to).toBeNull();
		expect(routed.started).toBe("☆ worker 1 · docs");
		const task = runtime.taskById(routed.taskId);
		expect(task?.status).toBe("queued");
		expect(task?.body).toBe("Write the FAQ.");
		expect(task?.parent_task).toBe(forwarded.taskId);
		expect(runtime.slots.forGroup(project.id, "docs", "worker")).toHaveLength(1);
		expect(runtime.slots.integratorFor(project.id, "docs")).not.toBeNull();
	});

	test("a lead forwards only a task it holds, one at a time, and never the same task twice", async () => {
		const me = personal();
		const lead = repoLeader();
		groupLeader("docs");
		expect(await forwardTask(deps(), lead, { group: "docs" })).toEqual({ ok: false, error: NO_OPEN_TASK });

		const first = hold(me, lead, "first request");
		const second = hold(me, lead, "second request");
		const ambiguous = await forwardTask(deps(), lead, { group: "docs" });
		expect(ambiguous.ok).toBe(false);
		if (!ambiguous.ok) {
			expect(ambiguous.error).toContain(first);
			expect(ambiguous.error).toContain(second);
		}

		const one = await forwardTask(deps(), lead, { group: "docs", taskId: first });
		if (!one.ok) throw new Error(one.error);
		expect(runtime.taskById(one.taskId)?.parent_task).toBe(first);
		expect((await forwardTask(deps(), lead, { group: "docs", taskId: first })).ok).toBe(false);

		const rest = await forwardTask(deps(), lead, { group: "docs" });
		if (!rest.ok) throw new Error(rest.error);
		expect(runtime.taskById(rest.taskId)?.parent_task).toBe(second);
		expect((await forwardTask(deps(), lead, { group: "docs" })).ok).toBe(false);
	});

	test("a group name that cannot be a branch is refused before anything is created", async () => {
		const me = personal();
		const lead = repoLeader();
		runtime.registry.setProjectWorkspace(project.id, "wXX");
		hold(me, lead, "Split the parser.");
		const routed = await forwardTask(deps(), lead, { group: "two words" });
		expect(routed.ok).toBe(false);
		expect(herdrCalls()).toEqual([]);
		expect(existsSync(join(root, "wt", project.id, "two words"))).toBe(false);
	});
});

describe("a human queues work in a group pane", () => {
	test("the queued task needs no task held from above, and the group gets a worker", () => {
		personal();
		repoLeader();
		const docs = groupLeader("docs");
		const queued = queueWork(deps(), docs, {
			task: "Write the FAQ.",
			kind: "docs",
			difficulty: "simple",
			requireOpenTask: false,
		});
		if (!queued.ok) throw new Error(queued.error);
		const task = runtime.taskById(queued.taskId);
		expect(task?.status).toBe("queued");
		expect(task?.parent_task).toBeNull();
		expect(queued.started).toBe("☆ worker 1 · docs");
	});
});

describe("a human names a worker", () => {
	test("the task lands on that worker and it claims the work", () => {
		personal();
		const lead = repoLeader();
		const docs = groupLeader("docs");
		const worker = must(
			runtime.register(
				{ role: "worker", cwd: join(root, "wt", project.id, "docs", "w1"), sessionId: "s-w1", projectId: project.id, projectName: project.name, group: "docs" },
				{ project },
			),
		);
		const assigned = assignWork(deps(), docs, {
			to: worker.seat,
			task: "create hi.txt containing ok",
			kind: "fix",
			difficulty: "simple",
			requireOpenTask: false,
		});
		return assigned.then((routed) => {
			if (!routed.ok) throw new Error(routed.error);
			expect(routed.to?.id).toBe(worker.id);
			const task = runtime.taskById(routed.taskId);
			expect(task?.status).toBe("assigned");
			expect(task?.to_seat).toBe(worker.seat);
			expect(task?.slot_id).toBe(runtime.slotOf(worker)?.id ?? "no slot");
		});
	});
});
