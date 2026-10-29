import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ASSIGNABLE_KINDS, TASK_DIFFICULTIES, type TaskDifficulty, type TaskKind } from "./config";
import type { TeamsHost } from "./host";
import type { AgentRow } from "./registry";
import { writeDailyReport } from "./report";
import { NO_OPEN_TASK } from "./runtime";
import { type SpawnDeps, spawnGroup, spawnProject, spawnWorker } from "./spawn";

export const TEAMS_TOOLS = [
	"teams_assign",
	"teams_report",
	"teams_progress",
	"teams_queue",
	"teams_spawn",
	"teams_retire",
	"teams_pause",
	"teams_merge",
	"teams_ask",
	"teams_write_report",
];

function text(
	body: string,
	details: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	return { content: [{ type: "text", text: body }], details };
}

async function waitForMembers(ready: () => AgentRow[] | null, signal: AbortSignal | undefined, timeoutMs = 150_000): Promise<AgentRow[] | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (signal?.aborted) return null;
		const members = ready();
		if (members) return members;
		await Bun.sleep(500);
	}
	return null;
}

function requireMember(host: TeamsHost): { ok: true; me: AgentRow } | { ok: false; message: string } {
	const me = host.refresh();
	if (!me) {
		return {
			ok: false,
			message:
				"ERROR: this session is not part of a team. A human must run /teams personal, /teams project, /teams group <name>, or /teams join <group> first.",
		};
	}
	return { ok: true, me };
}

export function registerTeamsTools(pi: ExtensionAPI, host: TeamsHost, spawnDeps: () => SpawnDeps | null): void {
	const z = pi.zod;
	const { runtime } = host;

	const assignSchema = z.object({
		to: z
			.string()
			.optional()
			.describe("Direct subordinate (label, agent id or seat). Group leads may omit it to queue the task for any free worker."),
		task: z.string().describe("Full task description the subordinate should execute"),
		kind: z.enum(ASSIGNABLE_KINDS).describe("Work direction, e.g. feature, fix, refactor, test, docs"),
		difficulty: z.enum(TASK_DIFFICULTIES).describe("Difficulty tier used for model routing"),
		paths: z.array(z.string()).optional().describe("Files or paths the task touches, for path_rules routing"),
		model: z.string().optional().describe("Explicit model override; must be listed in models.allowed"),
		parent_task: z
			.string()
			.optional()
			.describe("Id of the task you hold that this work serves (T-...). Needed only when you hold more than one task."),
	});

	const reportSchema = z.object({
		summary: z.string().describe("What happened, what is next, what is blocking"),
		status: z
			.enum(["progress", "done", "blocked", "failed"])
			.describe("progress: steady update (does not wake). done/blocked/failed: ends the task and wakes the manager"),
		task_id: z.string().optional().describe("Task id this report closes or updates"),
		sha: z.string().optional().describe("Commit SHA produced for the task; required for done on code tasks"),
	});

	const emptySchema = z.object({});

	const spawnSchema = z.object({
		role: z.enum(["project", "group", "worker"]).describe("What to spawn below you"),
		repo: z.string().optional().describe("Repository path, for role=project"),
		group: z.string().optional().describe("Group name, for role=group"),
		count: z.number().int().min(1).max(8).optional().describe("How many workers, for role=worker"),
	});

	const retireSchema = z.object({
		worker: z.string().describe("Worker label, agent id or seat"),
	});

	const pauseSchema = z.object({
		group: z.string().describe("Group name"),
		paused: z.boolean().describe("true stops workers from claiming new tasks; false resumes"),
	});

	const mergeSchema = z.object({
		task_id: z.string().describe("The merge task id from your task message"),
	});

	const askSchema = z.object({
		to: z.string().describe("Target member: label, agent id, seat, or `parent`"),
		question: z.string().describe("The question"),
	});

	pi.registerTool({
		name: "teams_assign",
		label: "Assign task",
		description:
			"Hand one task down one level. Project/personal managers must name a direct subordinate. A group lead may omit `to` to queue the task for the next free worker. `kind` and `difficulty` are required; the model is routed from them.",
		parameters: assignSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.assign(member.me, {
				to: params.to,
				task: params.task,
				kind: params.kind as TaskKind,
				difficulty: params.difficulty as TaskDifficulty,
				paths: params.paths,
				model: params.model,
				requireOpenTask: true,
				parentTask: params.parent_task,
			});
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			const where = result.to ? `to ${result.to.label}` : "on the group queue";
			return text(`assigned ${result.taskId} ${where}${result.model ? ` (model ${result.model})` : ""}.`, {
				ok: true,
				taskId: result.taskId,
				model: result.model,
				to: result.to?.id ?? null,
				queued: result.queued,
			});
		},
	});

	pi.registerTool({
		name: "teams_report",
		label: "Report to manager",
		description:
			"Report to your direct manager. `progress` is a steady update that does not wake the manager. `done` (with `sha` for code), `blocked` (needs a decision) and `failed` (gives the task back for a retry) end the task.",
		parameters: reportSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.report(member.me, {
				summary: params.summary,
				status: params.status,
				taskId: params.task_id,
				sha: params.sha,
			});
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			const note = result.followUp ? ` ${result.followUp}` : "";
			return text(`reported to ${result.to.label} (status ${params.status}).${note}`, { ok: true, to: result.to.id });
		},
	});

	pi.registerTool({
		name: "teams_progress",
		label: "Read subordinate progress",
		description: "Your direct subordinates and their latest report, read from the registry. Costs them nothing.",
		parameters: emptySchema,
		defaultInactive: true,
		execute: async () => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const entries = runtime.progress(member.me);
			if (entries.length === 0) return text("no direct subordinates", { ok: true, entries: [] });
			const lines = entries.map((entry) => {
				const report = entry.lastReport;
				const when = report ? `${Math.round((Date.now() - report.at) / 60000)}m ago` : "never";
				const flat = report?.summary?.replace(/\s+/g, " ") ?? "-";
				const summary = flat.length > 400 ? `${flat.slice(0, 400)}… (shortened here; the full report is in its [teams report] message)` : flat;
				return `${entry.agent.label} | session ${entry.session} | ${entry.current ? `▶ ${entry.current.id}` : "idle"} | last: ${report?.status ?? "-"} ${when} | ${summary}`;
			});
			return text(lines.join("\n"), {
				ok: true,
				entries: entries.map((entry) => ({ label: entry.agent.label, id: entry.agent.id, report: entry.lastReport })),
			});
		},
	});

	pi.registerTool({
		name: "teams_queue",
		label: "Read group queue",
		description: "The task list of your group (or of the group you lead): status, owner and title of every task.",
		parameters: emptySchema,
		defaultInactive: true,
		execute: async () => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			if (!member.me.group_name) return text("ERROR: you are not in a group; the queue belongs to a group.", { ok: false });
			return text(runtime.queueText(member.me), { ok: true });
		},
	});

	pi.registerTool({
		name: "teams_spawn",
		label: "Spawn subordinate",
		description:
			"Create subordinates with their own herdr panes and worktrees: a project lead (personal only), a group lead (project only), or workers (group only; the group's integrator comes with the first worker).",
		parameters: spawnSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params, signal) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			if ((member.me.role === "project" || member.me.role === "group") && !runtime.heldTask(member.me)) {
				return text(`ERROR: ${NO_OPEN_TASK}`, { ok: false });
			}
			const deps = spawnDeps();
			if (!deps) return text("ERROR: herdr is not available in this session; spawning needs a herdr pane.", { ok: false });
			const registry = runtime.registry;
			if (params.role === "project") {
				if (!params.repo) return text("ERROR: role=project needs `repo`", { ok: false });
				const spawned = spawnProject(deps, member.me, { repoPath: params.repo });
				if (!spawned.ok) return text(`ERROR: ${spawned.error}`, { ok: false });
				const seat = `project:${spawned.value.project.id}`;
				const live = await waitForMembers(() => {
					const lead = registry.bySeat(seat);
					return lead ? [lead] : null;
				}, signal);
				if (!live) return text(`ERROR: the repo leader for ${spawned.value.project.name} did not register in time.`, { ok: false });
				return text(`${live[0]?.label} is up. Assign it the objective with teams_assign({ to: "${live[0]?.id}", ... }).`, {
					ok: true,
					to: live[0]?.id,
				});
			}
			if (params.role === "group") {
				if (!params.group) return text("ERROR: role=group needs `group`", { ok: false });
				const spawned = spawnGroup(deps, member.me, { name: params.group });
				if (!spawned.ok) return text(`ERROR: ${spawned.error}`, { ok: false });
				const seat = `group:${member.me.project_id}/${params.group}`;
				const live = await waitForMembers(() => {
					const lead = registry.bySeat(seat);
					return lead ? [lead] : null;
				}, signal);
				if (!live) return text(`ERROR: the group leader of ${params.group} did not register in time.`, { ok: false });
				return text(`${live[0]?.label} is up. Assign it its slice with teams_assign({ to: "${live[0]?.id}", ... }).`, {
					ok: true,
					to: live[0]?.id,
				});
			}
			const spawned = spawnWorker(deps, member.me, { count: params.count ?? 1 });
			if (!spawned.ok) return text(`ERROR: ${spawned.error}`, { ok: false });
			const seats = spawned.value.map((worker) => `worker:${worker.slotId}`);
			const live = await waitForMembers(() => {
				const rows = seats.map((seat) => registry.bySeat(seat));
				return rows.every((row) => row !== null) ? (rows as AgentRow[]) : null;
			}, signal);
			if (!live) return text(`ERROR: spawned ${seats.length} worker(s) but not all registered in time.`, { ok: false });
			return text(
				`${live.map((row) => row.label).join(", ")} are up. Queue tasks with teams_assign (no \`to\`); free workers claim them.`,
				{ ok: true, workers: live.map((row) => row.label) },
			);
		},
	});

	pi.registerTool({
		name: "teams_retire",
		label: "Retire worker",
		description: "Ask one of your workers to stop after its current task. Group leads only.",
		parameters: retireSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.retire(member.me, params.worker);
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			return text(`${result.agent?.label ?? result.slot.id} will stop after its current task.`, { ok: true });
		},
	});

	pi.registerTool({
		name: "teams_pause",
		label: "Pause group",
		description: "Stop (or resume) a group's workers from claiming new tasks. Running tasks continue.",
		parameters: pauseSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.pause(member.me, params.group, params.paused);
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			return text(`group ${params.group} ${params.paused ? "paused" : "resumed"}.`, { ok: true });
		},
	});

	pi.registerTool({
		name: "teams_merge",
		label: "Merge into group branch",
		description:
			"Integrator only: merge the commit named by a merge task into the group branch. Conflicts and failed verification are sent back to the author automatically.",
		parameters: mergeSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.merge(member.me, params.task_id);
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			return text(result.summary, { ok: true });
		},
	});

	pi.registerTool({
		name: "teams_write_report",
		label: "Write the team report",
		description:
			"Write today's report (~/.omp/teams/reports/<date>.md) with every branch, head, changed file, blocker, spend and the paste-ready merge commands, and show a desktop notification. This is how a lead leaves a readable record for the human.",
		parameters: z.object({}).describe("no parameters"),
		defaultInactive: true,
		execute: async () => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const config = runtime.configOf(member.me);
			const state = runtime.guard(member.me);
			const report = writeDailyReport({
				db: runtime.db,
				home: runtime.home,
				now: Date.now(),
				budgetUsd: config.guards.budget.daily_usd,
				spendUsd: state.spendToday,
				haltReason: state.haltReason,
				projectRoot: (id) => (id ? runtime.registry.projectRoot(id) : null),
			});
			await host.notifyHerdr(`omp-teams ${new Date().toLocaleDateString()}`, report.path);
			return text(`report written to ${report.path}`, { ok: true, path: report.path });
		},
	});

	pi.registerTool({
		name: "teams_ask",
		label: "Ask a team member",
		description:
			"Message a peer, your direct manager or a direct subordinate: a question, or the answer to a subordinate's blocker (its task stays open). Use this instead of the built-in ask tool, which waits for a human.",
		parameters: askSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = runtime.ask(member.me, params.to, params.question);
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			return text(`question sent to ${params.to}`, { ok: true });
		},
	});
}
