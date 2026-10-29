import {
	aliveCount,
	bringUpGroup,
	check,
	createHarness,
	finish,
	lastLines,
	panes,
	paneTail,
	queryAll,
	queryOne,
	run,
	sh,
	waitFor,
} from "./harness";

const h = createHarness("m2", [
	"poll_ms: 700",
	"patrol_minutes: 0.2",
	"limits:",
	"  dead_after_seconds: 20",
	"  workers_per_tab: 4",
]);

interface SlotRow {
	id: string;
	kind: string;
	index_no: number;
	worktree: string;
	branch: string;
	pane_id: string | null;
	tab_id: string | null;
	status: string;
	agent_id: string | null;
	session_id: string | null;
}

function slots(): SlotRow[] {
	return queryAll<SlotRow>(h, "SELECT * FROM slots ORDER BY kind DESC, index_no");
}

function taskCount(where: string): number {
	return queryOne<{ n: number }>(h, `SELECT COUNT(*) AS n FROM tasks WHERE ${where}`)?.n ?? 0;
}

function showFile(worktree: string, branch: string, file: string): string | null {
	const proc = Bun.spawnSync(["git", "-C", worktree, "show", `${branch}:${file}`], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0 ? proc.stdout.toString().trim() : null;
}

function ompPid(paneId: string): number | null {
	const proc = Bun.spawnSync(["herdr", "pane", "process-info", "--pane", paneId], { stdout: "pipe", stderr: "pipe" });
	const text = proc.stdout.toString();
	if (!text) return null;
	const parsed = JSON.parse(text) as {
		result?: { process_info?: { foreground_processes?: { name?: string; pid?: number }[] } };
	};
	const omp = parsed.result?.process_info?.foreground_processes?.find((process) => process.name === "omp");
	return omp?.pid ?? null;
}

async function main(): Promise<void> {
	const up = await bringUpGroup(h, "feat-x");
	if (!up) finish(h, "M2");
	const { groupPane, workspaceId } = up;
	const group = queryOne<{ worktree: string; branch: string; tab_id: string | null }>(
		h,
		"SELECT worktree, branch, tab_id FROM groups WHERE name = 'feat-x'",
	);
	if (!group) {
		check(h, "group row exists", false);
		finish(h, "M2");
	}

	run(h, groupPane, "/teams spawn worker --count 2");
	const membersUp = await waitFor(() => aliveCount(h, "worker") === 3, 240_000, "two workers and the integrator");
	check(h, "`/teams spawn worker --count 2` brings up two workers and the integrator", membersUp, lastLines(groupPane, 3));
	if (!membersUp) finish(h, "M2");

	const integrator = slots().find((slot) => slot.kind === "integrator");
	check(
		h,
		"the integrator sits in the group lead's tab and works in the group worktree",
		Boolean(integrator) && integrator?.tab_id === group.tab_id && integrator?.worktree === group.worktree,
		JSON.stringify({ tab: integrator?.tab_id, leadTab: group.tab_id, worktree: integrator?.worktree }),
	);
	const INTEGRATOR_LABEL = "☆ integrator · feat-x";
	await waitFor(
		() => panes(h).some((pane) => pane.workspace_id === workspaceId && pane.display_agent === INTEGRATOR_LABEL),
		60_000,
		"integrator pane identity",
	);
	check(
		h,
		`the integrator pane advertises \`${INTEGRATOR_LABEL}\``,
		panes(h).some((pane) => pane.workspace_id === workspaceId && pane.display_agent === INTEGRATOR_LABEL),
	);

	run(h, groupPane, "/teams pause feat-x");
	await waitFor(() => (queryOne<{ paused: number }>(h, "SELECT paused FROM groups WHERE name = 'feat-x'")?.paused ?? 0) === 1, 20_000, "group paused");
	run(
		h,
		groupPane,
		"/teams assign queue feature simple Create a file named alpha.txt whose only content is the word alpha, commit it, then report done with the commit sha.",
	);
	await waitFor(() => taskCount("status = 'queued' AND kind = 'feature'") === 1, 20_000, "first task queued");
	await Bun.sleep(8_000);
	check(h, "a paused group leaves queued work unclaimed", taskCount("status = 'queued' AND kind = 'feature'") === 1);

	run(h, groupPane, "/teams resume feat-x");
	run(
		h,
		groupPane,
		"/teams assign queue feature simple Create a file named beta.txt whose only content is the word beta, commit it, then report done with the commit sha.",
	);

	const claimedByBoth = await waitFor(
		() => new Set(queryAll<{ slot_id: string }>(h, "SELECT slot_id FROM tasks WHERE kind = 'feature' AND slot_id IS NOT NULL").map((row) => row.slot_id)).size === 2,
		60_000,
		"both workers claim one task each",
	);
	check(h, "after resume, two free workers each claim one queued task", claimedByBoth);

	const merged = await waitFor(
		() => showFile(group.worktree, group.branch, "alpha.txt") === "alpha" && showFile(group.worktree, group.branch, "beta.txt") === "beta",
		600_000,
		"both files merged into the group branch",
	);
	const tasks = queryAll<{ id: string; kind: string; status: string; sha: string | null; source_sha: string | null }>(
		h,
		"SELECT id, kind, status, sha, source_sha FROM tasks ORDER BY created_at",
	);
	check(
		h,
		"both commits land in the group branch through the integrator",
		merged,
		tasks.map((task) => `${task.id}:${task.kind}:${task.status}`).join(" "),
	);
	const features = tasks.filter((task) => task.kind === "feature");
	const merges = tasks.filter((task) => task.kind === "merge");
	check(
		h,
		"every feature task is done with a SHA and has a done merge task for that SHA",
		features.length === 2 &&
			features.every((task) => task.status === "done" && task.sha) &&
			features.every((task) => merges.some((merge) => merge.source_sha === task.sha && merge.status === "done")),
		JSON.stringify(tasks),
	);
	const headLog = sh(group.worktree, ["git", "log", "--oneline", "-5", group.branch]);
	check(h, "the group branch has teams merge commits", headLog.includes("teams: merge"), headLog.replace(/\n/g, " | "));

	const w1 = slots().find((slot) => slot.kind === "worker" && slot.index_no === 1);
	const before = w1 ? queryOne<{ id: string; session_id: string }>(h, "SELECT id, session_id FROM agents WHERE seat = ? AND status = 'alive'", [`worker:${w1.id}`]) : null;
	const pid = w1?.pane_id ? ompPid(w1.pane_id) : null;
	check(h, "the worker pane runs an omp process", Boolean(pid), String(pid));
	if (w1 && pid && before) {
		process.kill(pid, "SIGKILL");
		const respawned = await waitFor(() => {
			const after = queryOne<{ session_id: string }>(h, "SELECT session_id FROM agents WHERE seat = ? AND status = 'alive'", [`worker:${w1.id}`]);
			return Boolean(after && after.session_id !== before.session_id);
		}, 120_000, "worker respawned into its seat");
		const after = queryOne<{ id: string; session_id: string; pane_id: string }>(
			h,
			"SELECT id, session_id, pane_id FROM agents WHERE seat = ? AND status = 'alive'",
			[`worker:${w1.id}`],
		);
		check(
			h,
			"a killed worker is restarted by its launcher and takes the same seat in the same pane",
			respawned && after?.pane_id === w1.pane_id,
			JSON.stringify({ before: before.session_id.slice(0, 8), after: after?.session_id.slice(0, 8), pane: after?.pane_id }),
		);
		const takeover = queryOne<{ detail: string }>(h, "SELECT detail FROM events WHERE kind = 'takeover' ORDER BY id DESC LIMIT 1");
		check(h, "the takeover is recorded as a same-pane restart", takeover?.detail.includes("same-pane") ?? false, takeover?.detail ?? "none");
	}

	const w2 = slots().find((slot) => slot.kind === "worker" && slot.index_no === 2);
	run(h, groupPane, `/teams retire worker:${w2?.id ?? "-"}`);
	const retired = await waitFor(
		() => queryOne<{ status: string }>(h, "SELECT status FROM slots WHERE id = ?", [w2?.id ?? ""])?.status === "retired",
		120_000,
		"w2 retired",
	);
	const w2Agent = queryOne<{ status: string }>(h, "SELECT status FROM agents WHERE seat = ? ORDER BY last_seen DESC LIMIT 1", [`worker:${w2?.id ?? ""}`]);
	await waitFor(() => paneTail(w2?.pane_id ?? "", 30).includes("member stopped"), 30_000, "launcher stop message");
	check(
		h,
		"a retired worker leaves and its launcher stops instead of restarting",
		retired && w2Agent?.status === "left" && paneTail(w2?.pane_id ?? "", 30).includes("member stopped"),
		JSON.stringify({ slot: retired, agent: w2Agent?.status, tail: lastLines(w2?.pane_id ?? "", 2) }),
	);
	await Bun.sleep(5_000);
	const workerRows = queryAll<{ label: string; status: string; seat: string; last_seen: number }>(
		h,
		"SELECT label, status, seat, last_seen FROM agents WHERE role = 'worker' ORDER BY registered_at",
	);
	const retiredRestarted = workerRows.some((row) => row.seat === `worker:${w2?.id ?? ""}` && row.status === "alive");
	check(
		h,
		"the retired worker is not restarted",
		!retiredRestarted,
		workerRows.map((row) => `${row.label}:${row.status}:${Math.round((Date.now() - row.last_seen) / 1000)}s`).join(" "),
	);
	const integratorAlive = workerRows.some((row) => row.label === INTEGRATOR_LABEL && row.status === "alive");
	const w1Alive = workerRows.some((row) => row.seat === `worker:${w1?.id ?? ""}` && row.status === "alive");
	const w1RetiredByLead =
		(queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM events WHERE kind = 'retire:requested' AND detail LIKE ?", [
			`%${w1?.id ?? "-"}%`,
		])?.n ?? 0) > 0;
	check(
		h,
		"the integrator stays alive, and w1 is alive unless its lead retired it",
		integratorAlive && (w1Alive || w1RetiredByLead),
		workerRows.map((row) => `${row.label}:${row.status}`).join(" "),
	);

	finish(h, "M2");
}

await main();
