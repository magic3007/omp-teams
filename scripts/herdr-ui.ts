import { sessionTag } from "../src/identity";
import { aliveCount, bringUpGroup, check, createHarness, finish, queryAll, queryOne, run, waitFor } from "./harness";

const ansi = process.argv.includes("--ansi");
const h = createHarness("ui", ["poll_ms: 700", "limits:", "  dead_after_seconds: 20"]);

interface Member {
	label: string;
	session_id: string;
	pane_id: string;
	role: string;
}

function screen(paneId: string, format: "text" | "ansi" = "text"): string {
	const args = ["herdr", "pane", "read", paneId, "--source", "visible", "--lines", "200"];
	if (format === "ansi") args.push("--format", "ansi");
	return Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

function statusRow(member: Member, format: "text" | "ansi" = "text"): string {
	const plain = screen(member.pane_id).split("\n");
	const index = plain.findLastIndex((line) => line.includes(member.label));
	if (index < 0) return "";
	return format === "ansi" ? (screen(member.pane_id, "ansi").split("\n")[index] ?? "") : (plain[index] ?? "");
}

function keys(paneId: string, ...names: string[]): void {
	Bun.spawnSync(["herdr", "pane", "send-keys", paneId, ...names], { stdout: "pipe", stderr: "pipe" });
}

function member(label: string): Member {
	const row = queryOne<Member>(h, "SELECT label, session_id, pane_id, role FROM agents WHERE status = 'alive' AND label = ?", [label]);
	if (!row) throw new Error(`no live member labelled ${label}`);
	return row;
}

function footerSession(paneId: string): string | null {
	return screen(paneId).match(/session {2}(\S+)/)?.[1] ?? null;
}

async function main(): Promise<void> {
	const up = await bringUpGroup(h, "feat-x");
	if (!up) finish(h, "UI");
	run(h, up.groupPane, "/teams spawn worker --count 2");
	const workersUp = await waitFor(() => aliveCount(h, "worker") === 3, 240_000, "two workers and the integrator");
	check(h, "two workers and the integrator come up", workersUp);
	if (!workersUp) finish(h, "UI");

	const personal = member("★★★ personal leader");
	const repo = member("★★ repo leader · repo");
	const lead = member("★ group leader · feat-x");
	const w1 = member("☆ worker 1 · feat-x");
	const w2 = member("☆ worker 2 · feat-x");
	const integrator = member("☆ integrator · feat-x");
	const everyone = [personal, repo, lead, w1, w2, integrator];
	const pool = everyone.map((who) => who.session_id);
	const tag = (who: Member): string => sessionTag(who.session_id, pool);
	check(h, "every member gets a distinct session tag", new Set(everyone.map(tag)).size === everyone.length, everyone.map(tag).join(" "));

	const expectations: [Member, string[]][] = [
		[personal, ["★★★ personal leader", "★★ 1 repo leader", "★ 1 group leader", "☆ 2 workers"]],
		[repo, ["★★ repo leader · repo", "★ 1 group leader", "☆ 2 workers", "↑ personal leader"]],
		[lead, ["★ group leader · feat-x", "teams/feat-x", "☆ 2 workers", "↑ repo leader · repo"]],
		[w1, ["☆ worker 1 · feat-x", "teams-w/feat-x/w1", "↑ group leader · feat-x"]],
		[w2, ["☆ worker 2 · feat-x", "teams-w/feat-x/w2", "↑ group leader · feat-x"]],
		[integrator, ["☆ integrator · feat-x", "teams/feat-x", "waiting for merges", "↑ group leader · feat-x"]],
	];
	await waitFor(() => expectations.every(([who, parts]) => parts.every((part) => statusRow(who).includes(part))), 60_000, "status lines");
	for (const [who, parts] of expectations) {
		const row = statusRow(who);
		const missing = parts.filter((part) => !row.includes(part));
		check(h, `status line of ${who.label}`, missing.length === 0, missing.length ? `missing ${missing.join(", ")} in: ${row.trim()}` : row.trim());
	}

	const widgetCases: [Member, Member[]][] = [
		[personal, [repo]],
		[repo, [lead]],
		[lead, [w1, w2, integrator]],
	];
	for (const [manager, reports] of widgetCases) {
		const text = screen(manager.pane_id);
		const missing = reports.filter((report) => !text.includes(`session ${tag(report)}`));
		check(
			h,
			`widget of ${manager.label} shows each report's session id`,
			missing.length === 0,
			missing.map((report) => report.label).join(", ") || reports.map(tag).join(" "),
		);
	}

	run(h, lead.pane_id, "/teams tree");
	const opened = await waitFor(() => screen(lead.pane_id).includes("team below ★ group leader · feat-x"), 20_000, "tree overlay");
	const overlay = screen(lead.pane_id);
	check(h, "`/teams tree` opens an overlay titled with the member", opened, opened ? "" : overlay.split("\n").slice(-8).join(" ⏎ "));
	const rowsMissing = [lead, w1, w2, integrator].filter(
		(who) => !overlay.split("\n").some((line) => line.includes(who.label) && line.includes(`session ${tag(who)}`)),
	);
	check(
		h,
		"the overlay lists the leader and every subordinate with rank, full name and session id",
		rowsMissing.length === 0 && overlay.includes("★ group leader · feat-x (you)") && overlay.includes("└─"),
		rowsMissing.map((who) => who.label).join(", ") || "all rows present",
	);
	check(h, "the overlay footer starts on the leader's full session id", footerSession(lead.pane_id) === lead.session_id, footerSession(lead.pane_id) ?? "none");

	const children = new Set([w1.session_id, w2.session_id, integrator.session_id]);
	keys(lead.pane_id, "down");
	await waitFor(() => footerSession(lead.pane_id) !== lead.session_id, 5_000, "selection moved");
	const second = footerSession(lead.pane_id);
	keys(lead.pane_id, "j");
	await waitFor(() => footerSession(lead.pane_id) !== second, 5_000, "selection moved again");
	const third = footerSession(lead.pane_id);
	keys(lead.pane_id, "k");
	await waitFor(() => footerSession(lead.pane_id) === second, 5_000, "selection moved back");
	check(
		h,
		"↓ / j / k move the selection and the footer follows it",
		Boolean(second && third && children.has(second) && children.has(third) && second !== third) && footerSession(lead.pane_id) === second,
		`${second} → ${third} → ${footerSession(lead.pane_id)}`,
	);
	keys(lead.pane_id, "esc");
	const closed = await waitFor(() => !screen(lead.pane_id).includes("team below"), 5_000, "overlay closed");
	check(h, "esc closes the overlay", closed);

	run(h, repo.pane_id, "/teams tree --all");
	const allOpened = await waitFor(() => screen(repo.pane_id).includes("whole team on this machine"), 20_000, "whole-machine overlay");
	const all = screen(repo.pane_id);
	check(
		h,
		"`/teams tree --all` shows every level, the viewer marked",
		allOpened && everyone.every((who) => all.includes(who.label)) && all.includes("★★ repo leader · repo (you)"),
		everyone.filter((who) => !all.includes(who.label)).map((who) => who.label).join(", ") || "all members present",
	);
	keys(repo.pane_id, "q");
	check(h, "q closes the overlay", await waitFor(() => !screen(repo.pane_id).includes("whole team on this machine"), 5_000, "closed"));

	run(h, personal.pane_id, "/teams tree --text --paths");
	const textShown = await waitFor(() => screen(personal.pane_id).includes("└─ ★★ repo leader · repo"), 20_000, "text tree");
	const text = screen(personal.pane_id);
	const sessionFiles = queryAll<{ session_file: string | null }>(h, "SELECT session_file FROM agents WHERE status = 'alive'")
		.map((row) => row.session_file)
		.filter((file): file is string => Boolean(file));
	check(
		h,
		"`/teams tree --text --paths` prints the hierarchy with session files",
		textShown &&
			text.includes("★★★ personal leader (you)") &&
			sessionFiles.some((file) => text.replace(/\s+/g, "").includes(file.split("/").pop() ?? "\u0000")),
		textShown ? `${sessionFiles.length} session files known` : text.split("\n").slice(-6).join(" ⏎ "),
	);

	run(h, lead.pane_id, "/teams assign queue feature simple Write a haiku about merges into poem.txt, commit it, report done with the sha.");
	await Bun.sleep(15_000);
	console.log("\nstatus lines:");
	for (const who of everyone) console.log(`  ${statusRow(who, ansi ? "ansi" : "text").trim()}${ansi ? "\u001b[0m" : ""}`);

	finish(h, "UI");
}

await main();
