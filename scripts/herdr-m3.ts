import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { aliveCount, bringUpGroup, check, createHarness, finish, lastLines, launchPersonal, paneExists, queryAll, queryOne, run, submit, waitFor } from "./harness";

const mode = process.env.MODE ?? "guards";

const config: Record<string, string[]> = {
	guards: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  group_blocked_per_hour: 1", "  budget:", "    daily_usd: 200"],
	budget: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  group_blocked_per_hour: 0", "  budget:", "    daily_usd: 200"],
	bootstrap: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  budget:", "    daily_usd: 200"],
	rebuild: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  budget:", "    daily_usd: 200"],
	fresh: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  budget:", "    daily_usd: 200", "rate_limits:", "  fresh_per_hour: 1"],
	park: [
		"poll_ms: 700",
		"patrol_minutes: 0.2",
		"limits:",
		"  dead_after_seconds: 20",
		"guards:",
		"  budget:",
		"    daily_usd: 200",
		"reclaim:",
		"  idle_minutes:",
		"    project: 0.3",
		"    group: 0.3",
	],
	close: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  budget:", "    daily_usd: 200"],
	analyst: ["poll_ms: 700", "patrol_minutes: 0.2", "limits:", "  dead_after_seconds: 20", "guards:", "  budget:", "    daily_usd: 200"],
};

const h = createHarness(`m3-${mode}`, config[mode] ?? config.guards ?? []);


function paneRunsOmp(paneId: string): boolean {
	const result = Bun.spawnSync(["herdr", "pane", "process-info", "--pane", paneId], { stdout: "pipe", stderr: "pipe" });
	return result.stdout.toString().includes('"name":"omp"');
}

function paneText(paneId: string, lines = 60): string {
	return Bun.spawnSync(["herdr", "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)], {
		stdout: "pipe",
		stderr: "pipe",
	}).stdout.toString();
}

function workspaceExists(workspaceId: string): boolean {
	return Bun.spawnSync(["herdr", "workspace", "list"], { stdout: "pipe", stderr: "pipe" }).stdout.toString().includes(`"${workspaceId}"`);
}

function reportPath(): string {
	const date = new Date();
	const day = `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;
	return join(h.teamsHome, "reports", `${day}.md`);
}

async function main(): Promise<void> {
	if (mode === "bootstrap") {
		const personalPane = launchPersonal(h);
		const up = await waitFor(() => aliveCount(h, "personal") === 1, 120_000, "personal registered");
		check(h, "personal registered before bootstrap", up);
		if (!up) finish(h, "M3");
		run(h, personalPane, `/teams bootstrap --yes --repo ${h.repo} --group boot --count 1`);
		const built = await waitFor(
			() =>
				aliveCount(h, "project") === 1 &&
				aliveCount(h, "group") === 1 &&
				queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM slots WHERE kind = 'worker'")?.n === 1 &&
				queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM slots WHERE kind = 'integrator'")?.n === 1,
			300_000,
			"bootstrap built the whole chain",
		);
		check(
			h,
			"`/teams bootstrap --yes` builds repo leader, group leader, worker and integrator",
			built,
			queryAll<{ label: string }>(h, "SELECT label FROM agents WHERE status = 'alive'")
				.map((row) => row.label)
				.join(", ") || lastLines(personalPane, 4),
		);
		check(h, "bootstrap registers the group it was asked for", Boolean(queryOne(h, "SELECT 1 AS n FROM groups WHERE name = 'boot'")));
		finish(h, "M3");
	}

	const up = await bringUpGroup(h, "feat-x");
	if (!up) finish(h, "M3");
	const { personalPane, projectPane, groupPane } = up;
	run(h, groupPane, "/teams spawn worker --count 1");
	const workerUp = await waitFor(() => aliveCount(h, "worker") === 2, 240_000, "worker and integrator");
	check(h, "a worker and the integrator are up", workerUp, lastLines(groupPane, 3));
	if (!workerUp) finish(h, "M3");

	if (mode === "close") {
		const members = queryAll<{ id: string; pane_id: string | null }>(
			h,
			"SELECT id, pane_id FROM agents WHERE role IN ('project','group','worker') AND status = 'alive'",
		);
		const memberPanes = members.map((row) => row.pane_id).filter((pane): pane is string => Boolean(pane));
		check(h, "the repo subtree has panes before closing", memberPanes.length === 4, memberPanes.join(", "));
		const sent = await submit(h, personalPane, "关闭 repo 的 repo leader 及其下属", () =>
			(queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'close'")?.n ?? 0) > 0,
		);
		check(h, "the request reaches the personal leader", sent, lastLines(personalPane, 4));
		const closed = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'close'")?.n ?? 0) === 1,
			240_000,
			"the personal leader called teams_close",
		);
		check(h, "one sentence makes the personal leader close the repo subtree in one call", closed, lastLines(personalPane, 6));
		const left = queryOne<{ n: number }>(
			h,
			`SELECT COUNT(*) AS n FROM agents WHERE id IN (${members.map(() => "?").join(", ")}) AND status = 'left'`,
			members.map((row) => row.id),
		)?.n;
		check(h, "every member below the personal leader has left", left === members.length, `${left ?? 0} of ${members.length}`);
		const panesGone = await waitFor(() => memberPanes.every((pane) => !paneExists(pane)), 120_000, "closed panes gone");
		check(h, "every closed member's pane is gone", panesGone, memberPanes.filter(paneExists).join(", "));
		const workspaceGone = await waitFor(() => !workspaceExists(up.workspaceId), 60_000, "repo workspace gone");
		check(h, "the repo workspace closes with its last pane", workspaceGone, up.workspaceId);
		const retired = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM slots WHERE status != 'retired'")?.n ?? -1;
		check(h, "every slot is retired", retired === 0, `${retired} slot(s) still active`);
		check(h, "the personal leader keeps running", aliveCount(h, "personal") === 1 && paneExists(personalPane));
		finish(h, "M3");
	}

	if (mode === "analyst") {
		const projectSeat = queryOne<{ seat: string }>(h, "SELECT seat FROM agents WHERE role = 'project' AND status = 'alive'")?.seat ?? "";
		run(h, personalPane, "/teams assign repo analysis simple What is the first line of README.md? Answer with that line only.");
		const analystRow = (): { id: string; worktree: string; branch: string; pane_id: string | null; status: string } | null =>
			queryOne(h, "SELECT id, worktree, branch, pane_id, status FROM slots WHERE kind = 'analyst' ORDER BY index_no LIMIT 1");
		const started = await waitFor(() => analystRow() !== null, 300_000, "an analyst slot exists");
		const slot = analystRow();
		check(h, "the repo leader starts an analyst for the analysis task", started && slot !== null, lastLines(projectPane, 4));
		if (!slot) finish(h, "M3");
		const parentOf = (): string | null =>
			queryOne<{ parent_seat: string }>(h, "SELECT parent_seat FROM agents WHERE seat = ?", [`worker:${slot.id}`])?.parent_seat ?? null;
		const registered = await waitFor(() => parentOf() !== null, 180_000, "the analyst registered");
		check(h, "the analyst reports to the repo leader", registered && parentOf() === projectSeat, parentOf() ?? "unregistered");
		check(h, "the analyst works on its own branch", slot.branch.startsWith("teams-a/"), slot.branch);
		const answered = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM tasks WHERE kind = 'analysis' AND to_seat = ? AND status = 'done'", [`worker:${slot.id}`])?.n ?? 0) === 1,
			600_000,
			"the analyst answered",
		);
		check(h, "the analyst answers and reports done", answered, lastLines(slot.pane_id ?? projectPane, 4));
		const retired = await waitFor(() => analystRow()?.status === "retired" && !existsSync(slot.worktree), 120_000, "analyst retired");
		check(h, "the analyst retires and its worktree is removed", retired, slot.worktree);
		const paneGone = await waitFor(() => !paneExists(slot.pane_id ?? ""), 60_000, "analyst pane gone");
		check(h, "the analyst pane closes", paneGone, slot.pane_id ?? "-");
		const delivered = await waitFor(
			() =>
				queryAll<{ body: string }>(h, "SELECT body FROM messages WHERE to_seat = 'personal' AND kind = 'report'").some((row) =>
					row.body.includes("# repo"),
				),
			400_000,
			"the answer reached the personal leader",
		);
		check(h, "the answer reaches the personal leader", delivered, lastLines(personalPane, 4));
		finish(h, "M3");
	}

	if (mode === "guards") {
		run(
			h,
			groupPane,
			'/teams assign queue infra simple Do not change any file. Immediately report blocked with summary: "waiting for a schema decision".',
		);
		const tripped = await waitFor(
			() => (queryOne<{ paused_reason: string | null }>(h, "SELECT paused_reason FROM groups WHERE name = 'feat-x'")?.paused_reason ?? null) === "blocked-rate",
			420_000,
			"blocked-rate guard paused the group",
		);
		const guardEvent = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'guard:blocked-rate'")?.n ?? 0;
		const escalated = queryOne<{ n: number }>(
			h,
			"SELECT COUNT(*) AS n FROM messages WHERE kind = 'report' AND json_extract(body, '$.status') = 'blocked'",
		)?.n ?? 0;
		check(h, "a group with too many blockers in an hour is paused", tripped, `guard events: ${guardEvent}`);
		check(h, "the pause is escalated up the chain", escalated >= 1, `${escalated} blocked report(s)`);
		check(h, "the brake reason is recorded on the group", guardEvent >= 1);

		run(h, groupPane, "/teams resume feat-x");
		const resumed = await waitFor(
			() => (queryOne<{ paused: number }>(h, "SELECT paused FROM groups WHERE name = 'feat-x'")?.paused ?? 1) === 0,
			30_000,
			"group resumed",
		);
		check(h, "`/teams resume <group>` lifts the brake pause", resumed);
	}

	if (mode === "budget") {
		writeFileSync(join(h.teamsHome, "config.yml"), "poll_ms: 700\npatrol_minutes: 0.2\nlimits:\n  dead_after_seconds: 20\nguards:\n  group_blocked_per_hour: 0\n  budget:\n    daily_usd: 0.001\n");
		run(h, groupPane, "/teams assign queue docs trivial Write one line into note.txt, commit it, report done with the sha.");
		const frozen = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'guard:budget'")?.n ?? 0) > 0,
			600_000,
			"budget brake tripped",
		);
		const spend = queryOne<{ total: number }>(h, "SELECT COALESCE(SUM(cost), 0) AS total FROM usage")?.total ?? 0;
		const paused = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM groups WHERE paused_reason = 'budget'")?.n ?? 0;
		check(h, "spend is recorded for today", spend > 0, `$${spend.toFixed(4)}`);
		check(h, "a spend over the budget freezes the team", frozen && paused >= 1, `budget events, ${paused} group(s) paused`);
		const tasksBefore = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM tasks")?.n ?? 0;
		run(h, groupPane, "/teams assign queue docs trivial this must be refused");
		await Bun.sleep(5_000);
		const tasksAfter = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM tasks")?.n ?? 0;
		check(h, "assignment is refused while the budget is spent", tasksAfter === tasksBefore, `${tasksBefore} -> ${tasksAfter}`);
		const showsBudget = paneText(personalPane).includes("budget spent");
		check(h, "the status line shows the spent budget", showsBudget);

		run(h, projectPane, "/teams halt budget acceptance");
		const halted = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'halt'")?.n ?? 0) > 0,
			30_000,
			"halt recorded",
		);
		check(
			h,
			"`/teams halt` records the stop and tells the members",
			halted && (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'notice'")?.n ?? 0) > 0,
		);
		run(h, personalPane, "/teams resume");
		const lifted = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'resume'")?.n ?? 0) > 0,
			60_000,
			"resume recorded",
		);
		const resumeDetail = queryOne<{ detail: string }>(h, "SELECT detail FROM events WHERE kind = 'resume' ORDER BY id DESC LIMIT 1")?.detail ?? "";
		check(
			h,
			"`/teams resume` lifts the halt and reports that the budget is still spent",
			lifted && resumeDetail.includes('"frozen":true'),
			resumeDetail || lastLines(personalPane, 4),
		);
	}

	if (mode === "rebuild") {
		const slot = queryOne<{ id: string; pane_id: string | null }>(h, "SELECT id, pane_id FROM slots WHERE kind = 'worker' ORDER BY index_no LIMIT 1");
		const before = queryOne<{ session_id: string }>(h, "SELECT session_id FROM agents WHERE seat = ? AND status = 'alive'", [`worker:${slot?.id ?? "-"}`]);
		if (!slot?.pane_id || !before) {
			check(h, "a worker pane and session exist before the rebuild", false);
			finish(h, "M3");
		}
		Bun.spawnSync(["herdr", "pane", "close", slot.pane_id], { stdout: "pipe", stderr: "pipe" });
		const gone = await waitFor(
			() => !Bun.spawnSync(["herdr", "pane", "get", slot.pane_id ?? ""], { stdout: "pipe", stderr: "pipe" }).stdout.toString().includes(slot.pane_id ?? "@@"),
			30_000,
			"pane gone",
		);
		check(h, "the worker pane is gone", gone);

		run(h, personalPane, "/teams resume");
		const rebuilt = await waitFor(() => {
			const row = queryOne<{ pane_id: string | null }>(h, "SELECT pane_id FROM slots WHERE id = ?", [slot.id]);
			return Boolean(row?.pane_id && row.pane_id !== slot.pane_id);
		}, 120_000, "pane rebuilt");
		const back = await waitFor(
			() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM agents WHERE seat = ? AND status = 'alive'", [`worker:${slot.id}`])?.n ?? 0) === 1,
			180_000,
			"worker back in its seat",
		);
		check(h, "`/teams resume` recreates the lost pane and relaunches the member", rebuilt && back, lastLines(personalPane, 4));
	}

	if (mode === "fresh") {
		run(h, groupPane, "/teams progress --fresh");
		const freshAnswer = await waitFor(
			() =>
				(queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'report' AND json_extract(body, '$.status') = 'progress'")?.n ?? 0) > 0,
			240_000,
			"a subordinate answered the fresh request",
		);
		const ping = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM messages WHERE kind = 'ping'")?.n ?? 0;
		check(h, "`/teams progress --fresh` pings every subordinate", ping >= 2, `${ping} ping(s)`);
		check(h, "a subordinate answers with one ephemeral status turn", freshAnswer);
		run(h, groupPane, "/teams progress --fresh");
		await Bun.sleep(5_000);
		const freshEvents = queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'fresh'")?.n ?? 0;
		check(h, "the fresh request is rate limited to one per hour", freshEvents === 1, `${freshEvents} request(s) went out`);

		const path = reportPath();
		if (existsSync(path)) rmSync(path);
		run(h, projectPane, "call the teams_write_report tool once, then report done with its path");
		const written = await waitFor(() => existsSync(path), 180_000, "teams_write_report wrote the file");
		check(h, "the `teams_write_report` tool writes the report", written, path);
	}

	if (mode === "park") {
		const parkedRow = (): { seat: string; pane_id: string | null; session_id: string; session_file: string | null } | null =>
			queryOne<{ seat: string; pane_id: string | null; session_id: string; session_file: string | null }>(
				h,
				"SELECT seat, pane_id, session_id, session_file FROM agents WHERE role IN ('project','group') AND status = 'parked' ORDER BY role = 'project' DESC LIMIT 1",
			);
		const parked = await waitFor(() => parkedRow() !== null, 600_000, "a launcher-started leader parked");
		const before = parkedRow();
		check(h, "a launcher-started leader parks when it sits idle", parked && before !== null, `${before?.seat ?? "none"} parked`);
		const parkedLine = await waitFor(
			() => paneText(before?.pane_id ?? "").includes("omp-teams: parked; waiting for work"),
			60_000,
			"the launcher printed the parked line",
		);
		check(h, "the launcher keeps the pane and prints the parked line", parkedLine, lastLines(before?.pane_id ?? projectPane, 4));
		const noOmp = await waitFor(() => !paneRunsOmp(before?.pane_id ?? ""), 60_000, "omp left the parked pane");
		check(h, "the parked pane runs no omp process", noOmp, lastLines(before?.pane_id ?? projectPane, 4));
		const saved = Boolean(before?.session_file && existsSync(before.session_file));
		const projectSeat = queryOne<{ seat: string }>(h, "SELECT seat FROM agents WHERE role = 'project' LIMIT 1")?.seat ?? "";

		run(
			h,
			personalPane,
			`/teams assign ${h.repo} docs trivial Write one line into note.txt, commit it and report done with the sha.`,
		);
		const woke = await waitFor(
			() =>
				(queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM agents WHERE seat = ? AND status = 'alive'", [
					before?.seat ?? "",
				])?.n ?? 0) === 1,
			300_000,
			"the parked leader woke up",
		);
		check(h, "a request through the personal leader wakes the parked leader", woke, lastLines(personalPane, 4));
		const holder = queryOne<{ session_id: string }>(h, "SELECT session_id FROM agents WHERE seat = ? AND status = 'alive'", [
			before?.seat ?? "",
		]);
		check(
			h,
			saved ? "the woken leader resumes its saved session" : "a leader with no transcript comes back as a fresh session",
			saved ? holder?.session_id === before?.session_id : holder !== null && holder.session_id !== before?.session_id,
			`${before?.session_id ?? "-"} -> ${holder?.session_id ?? "no holder"} (saved: ${saved})`,
		);
		const delivered = await waitFor(
			() =>
				(queryOne<{ n: number }>(
					h,
					"SELECT COUNT(*) AS n FROM messages WHERE to_seat = ? AND kind = 'task' AND delivered_at IS NOT NULL",
					[projectSeat],
				)?.n ?? 0) >= 1,
			120_000,
			"the task mail reached the woken leader",
		);
		check(h, "the task mail reaches the woken leader", delivered, lastLines(personalPane, 4));
		const finished = await waitFor(
			() =>
				(queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM tasks WHERE to_seat = ? AND status = 'done'", [projectSeat])?.n ??
					0) >= 1,
			600_000,
			"the woken leader finished the task",
		);
		check(h, "the woken leader finishes the task", finished, lastLines(personalPane, 4));
	}

	run(h, personalPane, "/teams digest");
	const written = await waitFor(() => existsSync(reportPath()), 60_000, "digest file written");
	const text = written ? readFileSync(reportPath(), "utf8") : "";
	check(h, "`/teams digest` writes today's report", written && text.includes("## 分支") && text.includes("## 合并"), reportPath());

	finish(h, "M3");
}

await main();
