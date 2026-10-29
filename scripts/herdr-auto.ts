/**
 * Autonomy acceptance: one sentence to the personal manager, nothing else.
 *
 * A human types a single request into the personal manager's pane. From there
 * every step is taken by the team itself: the personal manager spawns a project
 * lead, the project lead spawns group leads, group leads spawn workers and queue
 * tasks, workers commit, the integrator merges, and each manager closes its task
 * when everything it issued is done.
 *
 * The check is on outcomes only: the requested files exist with the requested
 * content on a group branch, and the task the personal manager issued is done.
 *
 * Run from inside herdr: `bun run test:herdr:auto` (takes several minutes).
 */
import {
	aliveCount,
	check,
	createHarness,
	finish,
	lastLines,
	launchPersonal,
	queryAll,
	queryOne,
	submit,
	waitFor,
} from "./harness";

const h = createHarness("auto", [
	"poll_ms: 1000",
	"patrol_minutes: 0.25",
	"limits:",
	"  dead_after_seconds: 30",
	"  max_workers_total: 6",
]);

const REQUEST = [
	`In the git repository at ${h.repo}, add two new files on a team branch:`,
	"colors.txt containing exactly the three lines red, green, blue;",
	"shapes.txt containing exactly the three lines circle, square, triangle.",
	"Use your team for this; do not ask me anything.",
].join(" ");

function branchFile(branch: string, file: string): string | null {
	const proc = Bun.spawnSync(["git", "-C", h.repo, "show", `${branch}:${file}`], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

function teamBranches(): string[] {
	const proc = Bun.spawnSync(["git", "-C", h.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/teams/"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	return proc.stdout.toString().split("\n").filter(Boolean);
}

function fileOnSomeBranch(file: string, expected: string): string | null {
	return teamBranches().find((branch) => branchFile(branch, file)?.replace(/\r/g, "") === expected) ?? null;
}

/** The request asks for both files on a team branch: one branch must carry both. */
function branchWithBoth(files: [string, string][]): string | null {
	return (
		teamBranches().find((branch) => files.every(([file, expected]) => branchFile(branch, file)?.replace(/\r/g, "") === expected)) ??
		null
	);
}

async function main(): Promise<void> {
	const personalPane = launchPersonal(h);
	const up = await waitFor(() => aliveCount(h, "personal") === 1, 120_000, "personal registered");
	check(h, "personal manager self-registers", up);
	if (!up) finish(h, "autonomy");

	const taken = await submit(h, personalPane, REQUEST, () => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM projects")?.n ?? 0) > 0);
	check(h, "the request reaches the personal leader", taken, taken ? "" : lastLines(personalPane, 4));
	if (!taken) finish(h, "autonomy");

	const colors = "red\ngreen\nblue";
	const shapes = "circle\nsquare\ntriangle";
	const wanted: [string, string][] = [
		["colors.txt", colors],
		["shapes.txt", shapes],
	];
	// Every task the personal leader issued must close; a duplicate task for the same request is a finding.
	const personalTasks = () =>
		queryAll<{ id: string; status: string }>(h, "SELECT id, status FROM tasks WHERE from_seat = 'personal' ORDER BY created_at");
	const closed = await waitFor(
		() => personalTasks().length >= 1 && personalTasks().every((task) => task.status === "done"),
		1_500_000,
		"every task of the personal leader closes",
	);
	// Workers may be retired once their work is done, so count the seats that ever existed.
	const tree = queryAll<{ label: string }>(h, "SELECT label FROM agents ORDER BY registered_at");
	const count = (sql: string): number => queryOne<{ n: number }>(h, sql)?.n ?? 0;
	check(
		h,
		"the team builds itself from one sentence: repo leader, group leader, workers",
		count("SELECT COUNT(*) AS n FROM projects") === 1 &&
			count("SELECT COUNT(*) AS n FROM groups") >= 1 &&
			count("SELECT COUNT(*) AS n FROM slots WHERE kind = 'worker'") >= 1,
		[...new Set(tree.map((row) => row.label))].join(", "),
	);
	// The team must never change main, whatever the leaders ask for.
	const mainLog = Bun.spawnSync(["git", "-C", h.repo, "rev-list", "--count", "main"], { stdout: "pipe" }).stdout.toString().trim();
	const mainStatus = Bun.spawnSync(["git", "-C", h.repo, "status", "--porcelain"], { stdout: "pipe" }).stdout.toString().trim();
	check(h, "main and the main checkout are untouched", mainLog === "1" && mainStatus === "", `commits on main: ${mainLog}; status: ${mainStatus || "clean"}`);
	// Two three-line files are a small objective: the repo leader's rule is one group for it.
	const groupNames = queryAll<{ name: string }>(h, "SELECT name FROM groups ORDER BY created_at").map((row) => row.name);
	check(h, "a small request is handled by one group", groupNames.length === 1, groupNames.join(", ") || "none");
	const both = branchWithBoth(wanted);
	const delivered = both !== null;
	check(
		h,
		"both requested files land on one team branch with the requested content",
		delivered,
		both ? `on ${both}` : `colors on ${fileOnSomeBranch("colors.txt", colors) ?? "-"}, shapes on ${fileOnSomeBranch("shapes.txt", shapes) ?? "-"}`,
	);

	const tasks = queryAll<{ id: string; from_seat: string; kind: string; status: string }>(
		h,
		"SELECT id, from_seat, kind, status FROM tasks ORDER BY created_at",
	);
	check(
		h,
		"the request is reported done up the chain",
		closed,
		tasks.map((task) => `${task.from_seat.split(":")[0]}→${task.kind}:${task.status}`).join(" "),
	);
	check(
		h,
		"the personal leader issued one task for one request",
		personalTasks().length === 1,
		personalTasks()
			.map((task) => `${task.id}:${task.status}`)
			.join(" "),
	);
	const blocked = tasks.filter((task) => task.status === "blocked");
	check(h, "nothing is left blocked", blocked.length === 0, blocked.map((task) => task.id).join(" "));

	// Convergence: once the request is closed, the team goes quiet instead of inventing follow-ups.
	const before = tasks.length;
	await Bun.sleep(90_000);
	const after = queryAll<{ id: string; status: string; title: string; from_seat: string }>(
		h,
		"SELECT id, status, title, from_seat FROM tasks ORDER BY created_at",
	);
	const open = after.filter((task) => ["queued", "assigned", "claimed", "running"].includes(task.status));
	const fresh = after.slice(before).filter((task) => task.from_seat !== "personal");
	check(
		h,
		"after the request closes, the leads start no new work and nothing stays open",
		open.length === 0 && fresh.length === 0,
		[...open, ...fresh].map((task) => `${task.id}:${task.status}:${task.title.slice(0, 40)}`).join(" | ") || "quiet",
	);

	// Integrity: every change reached the group branches through the integrator. A group that
	// committed nothing (only read) has no merges, and that is fine.
	const rewrites = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'merge:head-mismatch'")?.n ?? 0;
	const branches = teamBranches();
	const git = (args: string[]): string => Bun.spawnSync(["git", "-C", h.repo, ...args], { stdout: "pipe" }).stdout.toString().trim();
	const unmerged = branches.filter((branch) => git(["rev-list", "--count", `main..${branch}`]) !== "0" && !git(["log", "--oneline", branch]).includes("teams: merge"));
	check(
		h,
		"every changed group branch carries integrator merge commits and none was rewritten",
		rewrites === 0 && branches.length > 0 && unmerged.length === 0,
		`${branches.join(", ")} | without merges: ${unmerged.join(", ") || "none"} | head mismatches: ${rewrites}`,
	);
	const allBranches = Bun.spawnSync(["git", "-C", h.repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"], { stdout: "pipe" })
		.stdout.toString()
		.split("\n")
		.filter(Boolean);
	const stray = allBranches.filter((branch) => branch !== "main" && !branch.startsWith("teams/") && !branch.startsWith("teams-w/"));
	check(h, "no branch exists outside main, teams/* and teams-w/*", stray.length === 0, stray.join(", ") || allBranches.join(", "));
	const guarded = queryAll<{ label: string; tool: string }>(
		h,
		"SELECT a.label AS label, json_extract(e.detail, '$.tool') AS tool FROM events e LEFT JOIN agents a ON a.id = e.agent_id WHERE e.kind = 'block'",
	);
	console.log(`  (guard blocks: ${guarded.map((row) => `${row.label}:${row.tool}`).join(", ") || "none"})`);
	if (!closed || !delivered) console.log(`  personal pane: ${lastLines(personalPane, 6)}`);

	finish(h, "autonomy");
}

await main();
