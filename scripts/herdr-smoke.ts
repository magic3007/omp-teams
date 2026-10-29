/**
 * M1 acceptance harness: builds a real hierarchy inside herdr.
 *
 * What it proves:
 *   - `/teams spawn` puts personal -> project -> group -> workers into panes with
 *     the layout from PLAN D5 (workspace per repo; tabs `★★ repo leader`,
 *     `★ group leader · <g>`, `☆ workers · <g>`)
 *   - spawned members self-register through `OMP_TEAMS_JOIN`
 *   - every pane carries `display_agent` / state labels through herdr metadata
 *   - workers live in their own worktrees and a done report carries a real SHA
 *   - the status line renders inside the pane
 *
 * Run from inside herdr: `bun run test:herdr`.
 */
import { join } from "node:path";
import {
	aliveCount,
	bringUpGroup,
	check,
	createHarness,
	finish,
	lastLines,
	paneTail,
	panes,
	queryAll,
	queryOne,
	run,
	waitFor,
} from "./harness";

const h = createHarness("m1", ["poll_ms: 700", "limits:", "  dead_after_seconds: 20", "auto_integrator: false"]);

async function main(): Promise<void> {
	const up = await bringUpGroup(h, "feat-x");
	if (!up) finish(h, "M1");
	const { personalPane, groupPane, workspaceId } = up;

	// The separator glyph follows the user's symbol preset, so match the segments, not the divider.
	const statusRow = (): string =>
		paneTail(personalPane, 40)
			.split("\n")
			.find((line) => line.includes("★★★ personal leader") && line.includes("★★ 1 repo leader")) ?? "";
	await waitFor(() => statusRow() !== "", 30_000, "status line rendered");
	check(h, "the status line renders inside the pane with rank glyphs and full names", statusRow() !== "", statusRow().slice(0, 160) || "absent");
	check(h, "the repo leader lives in its own herdr workspace", Boolean(workspaceId), workspaceId);

	const groupRow = queryOne<{ worktree: string; branch: string }>(h, "SELECT worktree, branch FROM groups WHERE name = 'feat-x'") ?? {
		worktree: "",
		branch: "",
	};

	run(h, groupPane, "/teams spawn worker --count 2");
	const workersUp = await waitFor(() => aliveCount(h, "worker") === 2, 180_000, "two workers registered");
	check(h, "`/teams spawn worker` brings up two workers", workersUp, workersUp ? "" : lastLines(groupPane, 4));
	if (!workersUp) finish(h, "M1");

	const slots = queryAll<{ id: string; index_no: number; worktree: string; branch: string }>(
		h,
		"SELECT id, index_no, worktree, branch FROM slots WHERE kind = 'worker' ORDER BY index_no",
	);
	const workerSeats = queryAll<{ seat: string; label: string; cwd: string }>(
		h,
		"SELECT seat, label, cwd FROM agents WHERE role = 'worker' AND status = 'alive' ORDER BY label",
	);
	const groupDir = groupRow.worktree.replace(/\/group$/, "");
	check(
		h,
		"each worker has its own worktree and branch",
		slots.length === 2 &&
			slots[0]?.worktree !== slots[1]?.worktree &&
			slots.every((slot) => slot.branch.startsWith("teams-w/feat-x/w")) &&
			workerSeats.every((seat) => slots.some((slot) => slot.worktree === seat.cwd)),
		slots.map((slot) => `${slot.branch}@${slot.worktree}`).join(" "),
	);
	check(
		h,
		"worker seats are keyed by slot, not session",
		workerSeats.every((seat) => slots.some((slot) => seat.seat === `worker:${slot.id}`)),
		workerSeats.map((seat) => seat.seat).join(" "),
	);
	check(
		h,
		"worker worktrees sit beside the group worktree, one per slot",
		groupRow.worktree.endsWith("/group") && slots.every((slot) => slot.worktree.startsWith(`${groupDir}/w`)),
		`${groupRow.worktree} <- ${slots.map((slot) => slot.worktree).join(" ")}`,
	);

	await waitFor(
		() => panes(h).filter((pane) => pane.workspace_id === workspaceId && pane.display_agent?.startsWith("☆ worker ")).length >= 2,
		60_000,
		"both worker panes advertise their identity",
	);
	const displayAgents = panes(h)
		.filter((pane) => pane.workspace_id === workspaceId)
		.map((pane) => pane.display_agent)
		.filter(Boolean);
	check(
		h,
		"every pane in the project workspace advertises its rank and full name",
		displayAgents.includes("★★ repo leader · repo") &&
			displayAgents.includes("★ group leader · feat-x") &&
			displayAgents.filter((name) => name?.startsWith("☆ worker ") && name.endsWith(" · feat-x")).length >= 2,
		displayAgents.join(", "),
	);

	const tabsRaw = Bun.spawnSync(["herdr", "tab", "list", "--workspace", workspaceId], { stdout: "pipe", stderr: "pipe" }).stdout.toString();
	const tabLabels = tabsRaw
		? ((JSON.parse(tabsRaw) as { result?: { tabs?: { label?: string }[] } }).result?.tabs ?? []).map((tab) => tab.label ?? "")
		: [];
	check(
		h,
		"tabs are named `★★ repo leader`, `★ group leader · <g>` and `☆ workers · <g>`",
		tabLabels.includes("★★ repo leader") &&
			tabLabels.includes("★ group leader · feat-x") &&
			tabLabels.includes("☆ workers · feat-x"),
		tabLabels.join(" | "),
	);

	// Labels contain spaces; the seat is a single-token reference.
	const firstWorker = workerSeats[0];
	run(
		h,
		groupPane,
		`/teams assign ${firstWorker?.seat ?? "worker"} fix simple create a file named hi.txt containing ok, commit it, then report done with its sha`,
	);
	const taskDone = await waitFor(
		() => (queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM tasks WHERE status = 'done'")?.n ?? 0) >= 1,
		420_000,
		"worker completes the task",
	);
	const doneTask = queryOne<{ id: string; status: string; sha: string | null; slot_id: string | null }>(
		h,
		"SELECT id, status, sha, slot_id FROM tasks ORDER BY created_at DESC LIMIT 1",
	);
	check(h, "a worker executes an assigned task and reports done", taskDone && doneTask?.status === "done", JSON.stringify(doneTask));

	const workerWorktree = slots.find((slot) => slot.id === doneTask?.slot_id)?.worktree ?? "";
	if (doneTask?.sha) {
		const exists = Bun.spawnSync(["git", "-C", workerWorktree, "cat-file", "-e", `${doneTask.sha}^{commit}`]);
		check(h, "the reported SHA is a real commit in the worker's worktree", exists.exitCode === 0, doneTask.sha);
		const file = Bun.spawnSync(["cat", join(workerWorktree, "hi.txt")], { stdout: "pipe", stderr: "pipe" });
		check(h, "the worker's file landed in its own worktree", file.exitCode === 0, file.stdout.toString().trim());
	} else {
		check(h, "the done report carries a SHA", false);
	}

	finish(h, "M1");
}

await main();
