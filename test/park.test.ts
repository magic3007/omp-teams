import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { Herdr } from "../src/herdr";
import { type ProjectIdentity, resolveProject } from "../src/identity";
import type { AgentRow, RegisterResult } from "../src/registry";
import { assignWork, type RouteDeps } from "../src/route";
import { TeamsRuntime } from "../src/runtime";
import { launchFiles, launcherScript, seatLaunchFiles } from "../src/spawn";

let root: string;
let home: string;
let repo: string;
let db: Database;
let runtime: TeamsRuntime;
let project: ProjectIdentity;
let previousHerdr: string | undefined;

function git(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function must(result: RegisterResult): AgentRow {
	if (!result.ok) throw new Error(result.error);
	return result.agent;
}

function personal(): AgentRow {
	return must(runtime.register({ role: "personal", cwd: root, sessionId: "s-personal" }));
}

function repoLeader(session = "s-project"): AgentRow {
	return must(
		runtime.register(
			{ role: "project", cwd: repo, sessionId: session, projectId: project.id, projectName: project.name, paneId: "p1" },
			{ project },
		),
	);
}

function groupLeader(session = "s-group"): AgentRow {
	return must(
		runtime.register(
			{
				role: "group",
				cwd: repo,
				sessionId: session,
				projectId: project.id,
				projectName: project.name,
				group: "docs",
			},
			{ project, group: { worktree: repo, branch: "teams/docs" } },
		),
	);
}

function herdrCalls(): string[] {
	const log = join(root, "herdr-calls.log");
	return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
}

function deps(awaitMember: (seat: string) => Promise<AgentRow | null>): RouteDeps {
	return {
		runtime,
		spawn: { runtime, herdr: new Herdr(), home, config: runtime.configFor(repo) },
		awaitMember,
	};
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "omp-teams-park-"));
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
		'  "pane list") printf \'%s\' \'{"result":{"panes":[{"pane_id":"p1","tab_id":"t1","workspace_id":"w1","cwd":"/repo"}]}}\' ;;',
		'  "tab create") printf \'%s\' \'{"result":{"tab":{"tab_id":"w1:t9"},"root_pane":{"pane_id":"w1:p9","tab_id":"w1:t9","workspace_id":"w1","cwd":"/repo"}}}\' ;;',
		'  "pane run") printf \'%s\' \'{"result":{"type":"ok"}}\' ;;',
		'  "tab rename") printf \'%s\' \'{"result":{"type":"ok"}}\' ;;',
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

describe("a parked member keeps its seat", () => {
	test("a parked holder blocks a second registration and the same session revives it", () => {
		personal();
		const lead = repoLeader();
		const parked = runtime.park(lead);
		expect(parked.ok).toBe(true);

		expect(runtime.registry.bySeat(lead.seat)).toBeNull();
		expect(runtime.registry.holder(lead.seat)?.status).toBe("parked");

		const second = runtime.register(
			{ role: "project", cwd: repo, sessionId: "s-other", projectId: project.id, projectName: project.name },
			{ project },
		);
		expect(second.ok).toBe(false);
		if (!second.ok) expect(second.error).toContain("already held by");

		const row = runtime.registry.lastRowOfSession(lead.session_id);
		expect(row?.status).toBe("parked");
		const revived = runtime.registry.revive(row?.id ?? "");
		expect(revived?.status).toBe("alive");
		expect(runtime.registry.bySeat(lead.seat)?.session_id).toBe(lead.session_id);
	});

	test("a subordinate registers under a parked parent", () => {
		personal();
		const lead = repoLeader();
		runtime.park(lead);
		const group = runtime.register(
			{
				role: "group",
				cwd: repo,
				sessionId: "s-group",
				projectId: project.id,
				projectName: project.name,
				group: "docs",
			},
			{ project, group: { worktree: repo, branch: "teams/docs" } },
		);
		expect(group.ok).toBe(true);
		if (!group.ok) throw new Error(group.error);
		expect(group.agent.parent_seat).toBe(lead.seat);
	});

	test("a member with undelivered mail does not park", () => {
		personal();
		const lead = repoLeader();
		runtime.mailer.send({
			fromAgent: "s-personal",
			fromSeat: "personal",
			toSeat: lead.seat,
			toAgent: lead.id,
			kind: "report",
			body: { status: "progress", summary: "still here" },
		});
		const parked = runtime.park(lead);
		expect(parked.ok).toBe(false);
		expect(runtime.registry.bySeat(lead.seat)?.status).toBe("alive");
	});
});

describe("patrol leaves parked members alone", () => {
	test("a task whose owner is parked is neither requeued nor failed", () => {
		const me = personal();
		const lead = repoLeader();
		const assigned = runtime.assign(me, { to: lead.id, task: "write the guide", kind: "docs", difficulty: "simple" });
		expect(assigned.ok).toBe(true);
		if (!assigned.ok) throw new Error(assigned.error);

		runtime.park(lead);
		const result = runtime.patrol(me);
		expect(result.requeued).toEqual([]);
		expect(result.blocked).toEqual([]);
		expect(runtime.taskById(assigned.taskId)?.status).toBe("assigned");
	});
});

describe("waking mail", () => {
	test("a report to a parked seat stores the mail and touches the wake file", () => {
		personal();
		const lead = repoLeader();
		const group = groupLeader();
		runtime.park(lead);

		const wake = launchFiles(home, `project-${project.id}`).wake;
		expect(existsSync(wake)).toBe(false);

		const reported = runtime.report(group, { status: "done", summary: "the guide is written" });
		expect(reported.ok).toBe(true);
		expect(runtime.mailer.inbox(lead.seat).length).toBe(1);
		expect(existsSync(wake)).toBe(true);
	});

	test("passive mail to a parked seat waits in the inbox without a wake", () => {
		personal();
		const lead = repoLeader();
		const group = groupLeader();
		runtime.park(lead);

		const wake = launchFiles(home, `project-${project.id}`).wake;
		const reported = runtime.report(group, { status: "progress", summary: "half way" });
		expect(reported.ok).toBe(true);
		expect(runtime.mailer.inbox(lead.seat).length).toBe(1);
		expect(existsSync(wake)).toBe(false);
	});

	test("an ask to a parked seat touches the wake file", () => {
		const me = personal();
		const lead = repoLeader();
		runtime.park(lead);
		const wake = launchFiles(home, `project-${project.id}`).wake;
		const asked = runtime.ask(me, lead.seat, "which group should take this?");
		expect(asked.ok).toBe(true);
		expect(existsSync(wake)).toBe(true);
	});
});

describe("routing to a parked leader", () => {
	test("the request wakes the parked repo leader instead of starting a second one", async () => {
		const me = personal();
		const lead = repoLeader();
		runtime.park(lead);

		const awaited: string[] = [];
		const routed = await assignWork(
			deps(async (seat) => {
				awaited.push(seat);
				const parked = runtime.registry.holder(seat);
				if (parked?.status === "parked") runtime.registry.revive(parked.id);
				return runtime.registry.bySeat(seat);
			}),
			me,
			{ to: "app", task: "Add a CHANGELOG entry.", kind: "docs", difficulty: "trivial" },
		);
		if (!routed.ok) throw new Error(routed.error);
		expect(awaited).toEqual([`project:${project.id}`]);
		expect(routed.to?.id).toBe(lead.id);
		expect(runtime.taskById(routed.taskId)?.to_seat).toBe(lead.seat);
		expect(existsSync(launchFiles(home, `project-${project.id}`).wake)).toBe(true);
		expect(herdrCalls().some((call) => call.includes("workspace create"))).toBe(false);
		expect(herdrCalls().some((call) => call.includes("tab create"))).toBe(false);
	});

	test("a parked leader whose pane is gone is relaunched from its launcher", async () => {
		const me = personal();
		const lead = repoLeader();
		runtime.park(lead);
		runtime.registry.setPane(lead.id, "w1:p9");
		runtime.registry.setProjectWorkspace(project.id, "w1");
		const script = seatLaunchFiles(home, lead.seat).script;
		mkdirSync(join(home, "launch"), { recursive: true });
		writeFileSync(script, "#!/bin/sh\n");
		chmodSync(script, 0o755);

		const routed = await assignWork(
			deps(async (seat) => runtime.registry.bySeat(seat)),
			me,
			{ to: "app", task: "Add a CHANGELOG entry.", kind: "docs", difficulty: "trivial" },
		);
		expect(routed.ok).toBe(false);
		expect(herdrCalls().some((call) => call.startsWith("tab create"))).toBe(true);
		expect(herdrCalls().some((call) => call.includes("pane run") && call.includes("project-"))).toBe(true);
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

async function startLauncher(script: string, env: Record<string, string>): Promise<Launcher> {
	const proc = Bun.spawn(["sh", script], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	let text = "";
	void (async () => {
		for await (const chunk of proc.stdout) text += Buffer.from(chunk).toString();
	})();
	return {
		proc,
		output: () => text,
		argv: () => (existsSync(env.ARGV_FILE as string) ? readFileSync(env.ARGV_FILE as string, "utf8").trim().split("\n").filter(Boolean) : []),
	};
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, tick?: () => void): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		tick?.();
		if (predicate()) return true;
		await Bun.sleep(50);
	}
	return false;
}

function launcherScriptFile(tag: string): { script: string; home: string; wake: string; park: string } {
	const home = join(root, "teams");
	mkdirSync(join(home, "launch"), { recursive: true });
	const files = launchFiles(home, tag);
	const script = join(root, "launcher.sh");
	writeFileSync(script, launcherScript({ home, tag, cwd: root, join: `role=project`, model: "m" }));
	return { script, home, wake: files.wake, park: files.park };
}

describe("the launcher script", () => {
	test("a parked leader waits for work and resumes the same session when it is woken", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		const sessionFile = join(root, "session.jsonl");
		const { script, wake } = launcherScriptFile("project-p-1");
		const launcher = await startLauncher(script, {
			PATH: `${bin}:${process.env.PATH}`,
			ARGV_FILE: argvFile,
			SESSION_FILE: sessionFile,
			PARK_ON_RUN: "1",
			FAKE_SLEEP: "1",
		});

		expect(await waitUntil(() => launcher.argv().length >= 1, 15_000)).toBe(true);
		expect(await waitUntil(() => launcher.output().includes("omp-teams: parked; waiting for work"), 15_000)).toBe(true);
		writeFileSync(wake, "");
		expect(await waitUntil(() => launcher.argv().some((line) => line.includes("--resume")), 20_000)).toBe(true);
		expect(launcher.argv()[1]).toContain(`--resume ${sessionFile}`);
		launcher.proc.kill();
	}, 40_000);

	test("a park file that is already there resumes at once", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		const sessionFile = join(root, "session.jsonl");
		const { script, park } = launcherScriptFile("project-p-1");
		writeFileSync(park, sessionFile);
		const launcher = await startLauncher(script, {
			PATH: `${bin}:${process.env.PATH}`,
			ARGV_FILE: argvFile,
			SESSION_FILE: sessionFile,
			FAKE_SLEEP: "1",
		});
		expect(await waitUntil(() => launcher.argv().length >= 1, 15_000)).toBe(true);
		expect(launcher.argv()[0]).toContain(`--resume ${sessionFile}`);
		launcher.proc.kill();
	}, 30_000);

	test("a park file with no saved session starts a fresh session", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		const { script, park } = launcherScriptFile("project-p-1");
		writeFileSync(park, "");
		const launcher = await startLauncher(script, {
			PATH: `${bin}:${process.env.PATH}`,
			ARGV_FILE: argvFile,
			FAKE_SLEEP: "1",
		});
		expect(await waitUntil(() => launcher.argv().length >= 1, 15_000)).toBe(true);
		expect(launcher.argv()[0]).not.toContain("--resume");
		launcher.proc.kill();
	}, 30_000);

	test("the stop file ends the loop", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		const { script, home } = launcherScriptFile("project-p-1");
		const launcher = await startLauncher(script, {
			PATH: `${bin}:${process.env.PATH}`,
			ARGV_FILE: argvFile,
			SESSION_FILE: join(root, "session.jsonl"),
			FAKE_SLEEP: "1",
		});
		expect(await waitUntil(() => launcher.argv().length >= 1, 15_000)).toBe(true);
		writeFileSync(launchFiles(home, "project-p-1").stop, "1\n");
		expect(await waitUntil(() => launcher.proc.killed || launcher.output().includes("member stopped"), 15_000)).toBe(true);
		expect(launcher.output()).toContain("omp-teams: member stopped");
		launcher.proc.kill();
	}, 30_000);

	test("a park cycle is not counted as a fast exit", async () => {
		const bin = join(root, "bin");
		fakeOmp(bin);
		const argvFile = join(root, "argv.log");
		const sessionFile = join(root, "session.jsonl");
		const { script, wake } = launcherScriptFile("project-p-1");
		const launcher = await startLauncher(script, {
			PATH: `${bin}:${process.env.PATH}`,
			ARGV_FILE: argvFile,
			SESSION_FILE: sessionFile,
			PARK_ON_RUN: "1",
			FAKE_SLEEP: "0",
		});
		const keepAwake = () => writeFileSync(wake, "");
		try {
			expect(await waitUntil(() => launcher.argv().length >= 4, 20_000, keepAwake)).toBe(true);
		} finally {
			launcher.proc.kill();
		}
		expect(launcher.output()).not.toContain("not restarting");
	}, 40_000);
});
