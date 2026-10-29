import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { ASSIGNABLE_KINDS, TASK_DIFFICULTIES, type TaskDifficulty, type TaskKind } from "./config";
import type { TeamsHost } from "./host";
import { PARKED_GLYPH } from "./identity";
import { TEAMS_TOOLS_FOR } from "./policy";
import type { AgentRow } from "./registry";
import { writeDailyReport } from "./report";
import { assignWork, forwardTask, routeDeps } from "./route";
import type { SpawnDeps } from "./spawn";

export const TEAMS_TOOLS = [...new Set(Object.values(TEAMS_TOOLS_FOR).flatMap((names) => [...names]))];

function text(
	body: string,
	details: Record<string, unknown> = {},
): { content: { type: "text"; text: string }[]; details: Record<string, unknown> } {
	return { content: [{ type: "text", text: body }], details };
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
		repo: z
			.string()
			.describe("Repository the request belongs to: its name the way the human said it, or its path. The repo leader is started if it does not exist."),
		task: z.string().describe("The human's request word for word. Do not plan, split or reword it."),
		kind: z.enum(ASSIGNABLE_KINDS).describe("Work direction, e.g. feature, fix, refactor, test, docs"),
		difficulty: z.enum(TASK_DIFFICULTIES).describe("Difficulty tier used for model routing"),
		paths: z.array(z.string()).optional().describe("Files or paths the request names, for path_rules routing"),
		model: z.string().optional().describe("Explicit model override; must be listed in models.allowed"),
	});

	const forwardSchema = z.object({
		group: z
			.string()
			.optional()
			.describe("Group that should do the work (lowercase letters, digits and \"-\"). A repo leader names it; the group leader is started if it does not exist. A group leader leaves this out."),
		task_id: z.string().optional().describe("Held task to forward. Needed only when you hold more than one."),
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
		label: "Send a request to its repository",
		description:
			"Personal leader only: route one human request to the repo leader of the repository it belongs to, starting that leader when none exists. Send the request word for word; the repo leader takes it from there.",
		parameters: assignSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = await assignWork(routeDeps(runtime, spawnDeps()), member.me, {
				to: params.repo,
				task: params.task,
				kind: params.kind as TaskKind,
				difficulty: params.difficulty as TaskDifficulty,
				paths: params.paths,
				model: params.model,
			});
			if (!result.ok) {
				const ask = result.askHuman
					? "\nThe repository is unclear. Ask the human which repository this request belongs to, list the candidates above if there are any, and stop. Do not pick a candidate and do not try a name or path the human did not give."
					: "";
				return text(`ERROR: ${result.error}${ask}`, { ok: false });
			}
			const started = result.started ? ` (started ${result.started})` : "";
			return text(
				`routed ${result.taskId} to ${result.to?.label ?? "no one"}${started}${result.model ? ` (model ${result.model})` : ""}.`,
				{ ok: true, taskId: result.taskId, to: result.to?.id ?? null, started: result.started, model: result.model },
			);
		},
	});

	pi.registerTool({
		name: "teams_forward",
		label: "Forward the task you hold",
		description:
			"Repo and group leaders: pass the task you hold down one level, unchanged. A repo leader names the group and a missing group leader is started; a group leader queues into its own group and a missing worker is started. kind, difficulty, paths and model travel with the task.",
		parameters: forwardSchema,
		defaultInactive: true,
		execute: async (_toolCallId, params) => {
			const member = requireMember(host);
			if (!member.ok) return text(member.message, { ok: false });
			const result = await forwardTask(routeDeps(runtime, spawnDeps()), member.me, {
				group: params.group,
				taskId: params.task_id,
			});
			if (!result.ok) return text(`ERROR: ${result.error}`, { ok: false });
			const started = result.started ? ` (started ${result.started})` : "";
			const where = result.to ? `to ${result.to.label}` : "on the group queue";
			return text(`forwarded ${result.taskId} ${where}${started}.`, {
				ok: true,
				taskId: result.taskId,
				to: result.to?.id ?? null,
				started: result.started,
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
				const parked = entry.agent.status === "parked" ? `${PARKED_GLYPH} parked | ` : "";
				return `${parked}${entry.agent.label} | session ${entry.session} | ${entry.current ? `▶ ${entry.current.id} ${entry.current.title}` : "idle"} | last: ${report?.status ?? "-"} ${when} | ${summary}`;
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
