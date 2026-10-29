import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Mailer } from "../src/mail";
import { Registry } from "../src/registry";

const EXTENSION = join(import.meta.dir, "..", "src", "index.ts");
const MODEL = process.env.E2E_MODEL ?? "deepseek/deepseek-flash";
const PASSIVE_REPORTS = 10;

interface Session {
	name: string;
	cwd: string;
	child: ChildProcessWithoutNullStreams;
	starts: number;
	ends: number;
	ready: boolean;
}

const keep = process.argv.includes("--keep");
const root = mkdtempSync(join(tmpdir(), "omp-teams-e2e-"));
const teamsHome = join(root, "teams");
const repo = join(root, "repo");
const worktree = join(root, "repo-feat-x");
const sessions: Session[] = [];
const failures: string[] = [];

function sh(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

function check(name: string, ok: boolean, detail = ""): void {
	if (ok) {
		console.log(`  PASS  ${name}`);
		return;
	}
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
	console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}

function openTeamsDb(): Database {
	return new Database(join(teamsHome, "teams.db"));
}

function startSession(name: string, cwd: string, resumeSessionFile?: string): Session {
	const dir = join(root, "sessions", name);
	const child = spawn(
		"omp",
		[
			"--mode",
			"rpc",
			"--no-extensions",
			"--extension",
			EXTENSION,
			"--model",
			MODEL,
			"--session-dir",
			dir,
			...(resumeSessionFile ? ["-r", resumeSessionFile] : []),
		],
		{
			cwd,
			env: {
				...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("HERDR_"))),
				OMP_TEAMS_HOME: teamsHome,
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	);
	const session: Session = { name, cwd, child, starts: 0, ends: 0, ready: false };
	let buffer = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk: string) => {
		buffer += chunk;
		let index = buffer.indexOf("\n");
		while (index >= 0) {
			const line = buffer.slice(0, index).trim();
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
			if (!line.startsWith("{")) continue;
			let frame: unknown;
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (typeof frame !== "object" || frame === null || !("type" in frame)) continue;
			if (frame.type === "ready") session.ready = true;
			if (frame.type === "agent_start") session.starts++;
			if (frame.type === "agent_end") session.ends++;
		}
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		const text = chunk.trim();
		if (text) console.error(`[${name}] ${text.slice(0, 400)}`);
	});
	sessions.push(session);
	return session;
}

async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(100);
	}
	console.log(`  (timeout waiting for ${label})`);
	return false;
}

async function prompt(session: Session, message: string): Promise<void> {
	session.child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);
}

function stop(session: Session): void {
	session.child.kill("SIGKILL");
}

async function main(): Promise<void> {
	console.log(`root: ${root}`);
	mkdirSync(teamsHome, { recursive: true });
	mkdirSync(repo, { recursive: true });
	writeFileSync(
		join(teamsHome, "config.yml"),
		["limits:", "  dead_after_seconds: 6", "poll_ms: 500", ""].join("\n"),
	);

	sh(repo, ["git", "init", "-q", "-b", "main"]);
	sh(repo, ["git", "config", "user.email", "e2e@example.com"]);
	sh(repo, ["git", "config", "user.name", "e2e"]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	sh(repo, ["git", "add", "."]);
	sh(repo, ["git", "commit", "-qm", "init"]);
	sh(repo, ["git", "worktree", "add", "-q", worktree, "-b", "teams/feat-x"]);

	const personal = startSession("personal", root);
	const project = startSession("project", repo);
	const group = startSession("group", repo);
	const worker = startSession("worker", worktree);

	const allReady = await waitFor(() => sessions.every((s) => s.ready), 60_000, "rpc ready");
	check("four rpc sessions reach ready", allReady);
	if (!allReady) return finish();

	const db = openTeamsDb();
	const waitForRole = (role: string): Promise<boolean> =>
		waitFor(
			() =>
				(db.query("SELECT COUNT(*) AS n FROM agents WHERE role = ? AND status = 'alive'").get(role) as {
					n: number;
				}).n === 1,
			60_000,
			`${role} registered`,
		);

	await prompt(personal, "/teams personal");
	const personalOk = await waitForRole("personal");
	await prompt(project, "/teams project");
	const projectOk = personalOk && (await waitForRole("project"));
	await prompt(group, `/teams group feat-x --worktree ${worktree}`);
	const groupOk = projectOk && (await waitForRole("group"));
	await prompt(worker, "/teams join feat-x");
	const registered = groupOk && (await waitForRole("worker"));
	const rows = db.query("SELECT role, seat, label FROM agents WHERE status = 'alive' ORDER BY role").all() as {
		role: string;
		seat: string;
		label: string;
	}[];
	check(
		"personal -> project -> group -> worker registered",
		registered && rows.map((row) => row.role).join(",") === "group,personal,project,worker",
		JSON.stringify(rows),
	);

	const activeFor = (role: string): string[] => {
		const agent = db.query("SELECT id FROM agents WHERE role = ?").get(role) as { id: string } | null;
		if (!agent) return [];
		const event = db
			.query("SELECT detail FROM events WHERE kind = 'tools:policy' AND agent_id = ? ORDER BY id DESC LIMIT 1")
			.get(agent.id) as { detail: string } | null;
		if (!event) return [];
		const parsed: unknown = JSON.parse(event.detail);
		if (typeof parsed !== "object" || parsed === null || !("active" in parsed)) return [];
		const active = parsed.active;
		return Array.isArray(active) ? active.filter((name): name is string => typeof name === "string") : [];
	};
	await waitFor(() => activeFor("group").length > 0 && activeFor("worker").length > 0, 20_000, "tool policies applied");
	const managerTools = activeFor("group");
	const workerTools = activeFor("worker");
	check(
		"group manager has no execution tools",
		["bash", "edit", "write", "ast_edit", "task"].every((tool) => !managerTools.includes(tool)) &&
			managerTools.includes("teams_assign") &&
			managerTools.includes("read"),
		managerTools.join(","),
	);
	check(
		"worker keeps execution tools and gains teams tools",
		["bash", "edit", "write", "teams_report", "teams_ask"].every((tool) => workerTools.includes(tool)),
		workerTools.join(","),
	);
	check(
		"worker does not have the built-in ask tool",
		!workerTools.includes("ask"),
		workerTools.join(","),
	);

	const registry = new Registry(db, { deadAfterMs: 6_000 });
	const mailer = new Mailer(db);
	const groupAgent = registry.allAlive().find((row) => row.role === "group");
	const workerAgent = registry.allAlive().find((row) => row.role === "worker");
	if (!groupAgent || !workerAgent) {
		check("group lead and worker rows exist", false);
		return finish();
	}

	group.starts = 0;
	for (let i = 1; i <= PASSIVE_REPORTS; i++) {
		mailer.send({
			fromAgent: workerAgent.id,
			fromSeat: workerAgent.seat,
			toSeat: groupAgent.seat,
			toAgent: groupAgent.id,
			kind: "report",
			body: { status: "progress", summary: `step ${i} of ${PASSIVE_REPORTS}` },
		});
	}
	await waitFor(() => {
		const pending = db
			.query("SELECT COUNT(*) AS n FROM messages WHERE to_seat = ? AND delivered_at IS NULL")
			.get(groupAgent.seat) as { n: number };
		return pending.n === 0;
	}, 20_000, "passive reports delivered");
	await Bun.sleep(3_000);
	check(
		`${PASSIVE_REPORTS} passive reports start at most one turn on the idle manager`,
		group.starts <= 1,
		`turns=${group.starts}`,
	);

	const deliveredRows = db
		.query("SELECT COUNT(*) AS n FROM messages WHERE to_seat = ? AND delivered_at IS NOT NULL")
		.get(groupAgent.seat) as { n: number };
	const deliverEvents = db
		.query("SELECT detail FROM events WHERE kind = 'mail:deliver' AND agent_id = ?")
		.all(groupAgent.id) as { detail: string }[];
	const injected = deliverEvents.reduce((total, row) => {
		const parsed: unknown = JSON.parse(row.detail);
		if (typeof parsed !== "object" || parsed === null || !("count" in parsed)) return total;
		return total + (typeof parsed.count === "number" ? parsed.count : 0);
	}, 0);
	check(
		"each delivered message is injected exactly once",
		deliveredRows.n === PASSIVE_REPORTS && injected === PASSIVE_REPORTS,
		`delivered=${deliveredRows.n} injected=${injected}`,
	);

	worker.starts = 0;
	mailer.send({
		fromAgent: groupAgent.id,
		fromSeat: groupAgent.seat,
		toSeat: workerAgent.seat,
		toAgent: workerAgent.id,
		kind: "task",
		body: {
			task_id: "T-E2E1",
			title: "touch a file",
			kind: "fix",
			difficulty: "simple",
			text: "Create a file named e2e-note.txt in the current directory with the text ok, then report done.",
		},
	});
	const wokeUp = await waitFor(() => worker.starts >= 1, 60_000, "worker turn after task");
	check("an idle worker starts a turn when a task arrives", wokeUp, `turns=${worker.starts}`);
	await waitFor(() => worker.ends >= 1, 120_000, "worker turn to finish");

	const workerRow = db.query("SELECT session_file FROM agents WHERE id = ?").get(workerAgent.id) as {
		session_file: string | null;
	} | null;
	const strandedId = mailer.send({
		fromAgent: groupAgent.id,
		fromSeat: groupAgent.seat,
		toSeat: workerAgent.seat,
		toAgent: workerAgent.id,
		kind: "task",
		body: {
			task_id: "T-E2E2",
			title: "second task",
			kind: "fix",
			difficulty: "simple",
			text: "Report progress with teams_report status progress.",
		},
	});
	stop(worker);
	await Bun.sleep(1_000);
	const stillUndelivered = (
		db.query("SELECT delivered_at FROM messages WHERE id = ?").get(strandedId) as { delivered_at: number | null }
	).delivered_at;
	check("mail to a stopped member stays undelivered instead of being lost", stillUndelivered === null);

	if (workerRow?.session_file) {
		console.log(`  (worker session file: ${workerRow.session_file}, exists=${existsSync(workerRow.session_file)})`);
		const resumed = startSession("worker-resume", worktree, workerRow.session_file);
		const resumedReady = await waitFor(() => resumed.ready, 60_000, "resumed worker ready");
		const redelivered = await waitFor(
			() =>
				(db.query("SELECT delivered_at FROM messages WHERE id = ?").get(strandedId) as {
					delivered_at: number | null;
				}).delivered_at !== null,
			30_000,
			"stranded mail delivered after restart",
		);
		check("a restarted member receives its stranded mail", resumedReady && redelivered);
		const restoredTurn = await waitFor(() => resumed.starts >= 1, 30_000, "turn on the restarted member");
		check("the restored message starts a turn on the restarted member", restoredTurn, `turns=${resumed.starts}`);
		stop(resumed);
	} else {
		console.log(`  (sessions dir: ${JSON.stringify(readdirSync(join(root, "sessions"), { recursive: true }))})`);
		check("the worker row records its session file", false);
	}

	const died = await waitFor(
		() =>
			(db.query("SELECT status FROM agents WHERE id = ?").get(workerAgent.id) as { status: string }).status ===
			"dead",
		30_000,
		"worker marked dead",
	);
	check("a killed member is marked dead without manual intervention", died);

	db.close();
	finish();
}

function finish(): void {
	for (const session of sessions) {
		if (!session.child.killed) session.child.kill("SIGKILL");
	}
	if (failures.length > 0) {
		console.log(`\n${failures.length} check(s) failed`);
		if (!keep) rmSync(root, { recursive: true, force: true });
		process.exit(1);
	}
	console.log("\nall M0 checks passed");
	if (!keep) rmSync(root, { recursive: true, force: true });
	process.exit(0);
}

await main();
