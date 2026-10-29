import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { registerTeamsCommands } from "./commands";
import { logEvent, openDb, teamsHome } from "./db";
import { currentPaneId, Herdr, herdrAvailable } from "./herdr";
import type { TeamsHost } from "./host";
import { PARKED_GLYPH, resolveProject } from "./identity";
import { decideDelivery, type MailRow, mailBody, persistedMsgIds, renderMail } from "./mail";
import {
	isManagerRole,
	isTeamsTool,
	leaderBlockReason,
	TEAMS_TOOLS_FOR,
	type ToolSeat,
	type WorkerBounds,
	workerBlockReason,
} from "./policy";
import type { ThemeColor } from "@oh-my-pi/pi-tui/theme";
import { type Painter, paneStateLabels, paneTitle, statusLine, type Tone, widgetLines } from "./presence";
import { systemPromptFor, taskPreface } from "./prompt";
import type { AgentRow } from "./registry";
import { TeamsRuntime } from "./runtime";
import { decodeJoin, type SpawnDeps, writeLaunchFile } from "./spawn";
import { registerTeamsTools, TEAMS_TOOLS } from "./tools";

const MAIL_CUSTOM_TYPE = "teams-mail";
const METADATA_INTERVAL_MS = 30_000;

const TONE_COLORS: Record<Tone, ThemeColor> = {
	accent: "accent",
	muted: "muted",
	dim: "dim",
	success: "success",
	warning: "warning",
	error: "error",
	branch: "statusLineGitClean",
};

function themePainter(ctx: ExtensionContext): Painter {
	const theme = ctx.ui.theme;
	return {
		icon: (key) => theme.symbol(key),
		paint: (tone, text, bold) => {
			const colored = theme.fg(TONE_COLORS[tone], text);
			return bold ? theme.bold(colored) : colored;
		},
		separator: () => theme.fg("statusLineSep", theme.symbol("sep.powerlineThin")),
	};
}

export default function teamsExtension(pi: ExtensionAPI): void {
	const db = openDb();
	const runtime = new TeamsRuntime({ db });
	const herdr = new Herdr();

	let self: AgentRow | null = null;
	let sessionId: string | null = null;
	let activeCtx: ExtensionContext | null = null;
	let baselineTools: string[] | null = null;
	let timer: ReturnType<ExtensionContext["setInterval"]> | null = null;
	let delivering = false;
	let lastSpendAt = 0;
	let stopping = false;
	let lastStatus = "";
	let lastWidget = "";
	let lastMetadataAt = 0;
	let lastPatrolAt = 0;
	let metadataSeq = 0;
	let idleSince = 0;

	const host: TeamsHost = {
		runtime,
		me: () => self,
		refresh: () => {
			self = sessionId ? runtime.me(sessionId) : null;
			if (self && activeCtx && !timer) startTimer(activeCtx);
			return self;
		},
		db,
		applyToolPolicy,
		teamsTools: () => TEAMS_TOOLS,
		notify: (message, level = "info") => {
			if (activeCtx?.hasUI) activeCtx.ui.notify(message, level === "warn" ? "warning" : level);
			else console.error(`[omp-teams] ${message}`);
		},
		notifyHerdr: async (title, body) => {
			if (!herdrAvailable()) return;
			Bun.spawnSync(["herdr", "notification", "show", title, "--body", body], { stdout: "ignore", stderr: "ignore" });
		},
		stopMember,
	};

	function isIntegrator(agent: AgentRow): boolean {
		return agent.role === "worker" && runtime.slotOf(agent)?.kind === "integrator";
	}

	function toolSeat(agent: AgentRow): ToolSeat {
		if (agent.role !== "worker") return agent.role;
		return isIntegrator(agent) ? "integrator" : "worker";
	}

	function stopMember(): void {
		if (stopping) return;
		stopping = true;
		const stopFile = process.env.OMP_TEAMS_STOP;
		if (stopFile) writeFileSync(stopFile, `${Date.now()}\n`);
		activeCtx?.shutdown();
	}

	function rotateMember(reason: string): void {
		if (stopping || !process.env.OMP_TEAMS_STOP) return;
		stopping = true;
		logEvent(db, "rotate", { reason }, self?.id);
		activeCtx?.shutdown();
	}

	function spawnDeps(): SpawnDeps | null {
		if (!herdrAvailable()) return null;
		const projectRoot = self?.project_id ? runtime.registry.projectRoot(self.project_id) : undefined;
		return { runtime, herdr, home: teamsHome(), config: runtime.configFor(projectRoot ?? undefined) };
	}

	async function applyToolPolicy(): Promise<void> {
		const base = baselineTools ?? pi.getActiveTools();
		if (!self) {
			await pi.setActiveTools(base);
			return;
		}
		const seat = toolSeat(self);
		const rest = base.filter((name) => !isTeamsTool(name));
		const active =
			seat === "worker"
				? [...rest, ...TEAMS_TOOLS_FOR.worker].filter((name) => name !== "ask")
				: [...TEAMS_TOOLS_FOR[seat]];
		await pi.setActiveTools(active);
		logEvent(db, "tools:policy", { role: self.role, integrator: seat === "integrator", active }, self.id);
	}

	async function applyTaskModel(ctx: ExtensionContext, rows: MailRow[]): Promise<void> {
		if (self?.role !== "worker" || !ctx.isIdle()) return;
		const task = rows.find((row) => row.kind === "task");
		if (!task) return;
		const wanted = mailBody(task).model;
		if (!wanted) return;
		const current = ctx.models.current();
		if (current && `${current.provider}/${current.id}` === wanted) return;
		const model = ctx.models.resolve(wanted);
		if (!model) {
			logEvent(db, "model:unresolved", { wanted }, self?.id);
			return;
		}
		try {
			await pi.setModel(model);
			logEvent(db, "model:switch", { wanted, taskId: mailBody(task).task_id }, self?.id);
		} catch (error) {
			logEvent(db, "model:error", { wanted, message: (error as Error).message }, self?.id);
		}
	}

	async function answerFreshStatus(ctx: ExtensionContext, me: AgentRow, row: MailRow): Promise<void> {
		if (!ctx.runEphemeralTurn) return;
		const task = runtime.currentTask(me);
		const promptText = [
			"You are a member of an omp-teams hierarchy and your manager asked for a fresh status.",
			`Your task right now: ${task ? `${task.id} ${task.title}` : "none (idle)"}.`,
			"Answer in at most 5 short lines, no preamble: (1) what you are doing now, (2) anything blocked, (3) what is next.",
		].join("\n");
		try {
			const result = await ctx.runEphemeralTurn({ promptText, maxTokens: 400 });
			const summary = result.replyText.trim().slice(0, 1500);
			if (!summary) return;
			const reported = runtime.report(me, { status: "progress", summary, taskId: task?.id });
			if (!reported.ok) logEvent(db, "fresh:reply-failed", { error: reported.error }, me.id);
		} catch (error) {
			logEvent(db, "fresh:error", { message: (error as Error).message }, me.id);
		}
	}

	function recordSpendTick(ctx: ExtensionContext, me: AgentRow): void {
		const now = Date.now();
		if (now - lastSpendAt < 30_000) return;
		lastSpendAt = now;
		try {
			const stats = ctx.sessionManager.getUsageStatistics();
			runtime.recordUsage(me, stats.cost, { tokens: { input: stats.input, output: stats.output } });
		} catch (error) {
			logEvent(db, "usage:error", { message: (error as Error).message }, me.id);
		}
	}

	async function deliverInbox(ctx: ExtensionContext): Promise<void> {
		if (delivering) return;
		const me = self;
		if (!me) return;
		if (me.role === "worker" && runtime.slotOf(me)?.manual === 1) return;
		delivering = true;
		try {
			const rows = runtime.takeInbox(me);
			if (rows.length === 0) return;
			idleSince = 0;
			const labelOf = (agentId: string, seat: string): string => runtime.registry.byId(agentId)?.label ?? seat;
			const idle = ctx.isIdle();
			let claimedTurn = false;

			await applyTaskModel(ctx, rows);

			const slot = me.role === "worker" ? runtime.slotOf(me) : null;
			const preface = taskPreface(me, slot?.kind === "worker" ? { worktree: slot.worktree, branch: slot.branch } : null);
			for (const row of rows.filter((candidate) => candidate.wake === 1)) {
				const busy = !idle || claimedTurn;
				const decision = decideDelivery(row.kind, true, busy);
				if (decision.abortFirst) ctx.abort();
				pi.sendMessage(
					{
						customType: MAIL_CUSTOM_TYPE,
						content: renderMail(row, labelOf(row.from_agent, row.from_seat), preface),
						display: true,
						details: { teamsMsgIds: [row.id], kind: row.kind },
					},
					{ deliverAs: decision.deliverAs, triggerTurn: decision.triggerTurn },
				);
				runtime.mailer.markDelivered([row.id]);
				if (row.kind === "task" && row.task_id) runtime.taskDelivered(row.task_id, me);
				if (decision.triggerTurn) claimedTurn = true;
			}

			const passive = rows.filter((candidate) => candidate.wake === 0);
			if (passive.length > 0) {
				const decision = decideDelivery("report", false, !idle || claimedTurn);
				const content = passive
					.map((row) => renderMail(row, labelOf(row.from_agent, row.from_seat)))
					.join("\n\n---\n\n");
				const ids = passive.map((row) => row.id);
				pi.sendMessage(
					{ customType: MAIL_CUSTOM_TYPE, content, display: true, details: { teamsMsgIds: ids, kind: "report" } },
					{ deliverAs: decision.deliverAs, triggerTurn: false },
				);
				runtime.mailer.markDelivered(ids);
			}
			for (const row of rows) if (row.kind === "ping" && mailBody(row).fresh === true) void answerFreshStatus(ctx, me, row);
			logEvent(db, "mail:deliver", { count: rows.length, idle }, me.id);
		} finally {
			delivering = false;
		}
	}

	function workerTick(ctx: ExtensionContext, me: AgentRow): void {
		if (stopping || !ctx.isIdle()) return;
		if (runtime.currentTask(me)) return;
		const slot = runtime.slotOf(me);
		if (!slot) return;
		if (slot.status === "retiring") {
			runtime.slots.setStatus(slot.id, "retired");
			runtime.leave(me);
			logEvent(db, "retire", { slot: slot.id }, me.id);
			stopMember();
			return;
		}
		if (slot.manual === 1) return;
		const config = runtime.configOf(me);
		const usage = ctx.getContextUsage();
		const contextFull = usage !== undefined && usage.percent >= config.rotate.context_pct;
		if (slot.tasks_done >= config.rotate.tasks || contextFull) {
			rotateMember(contextFull ? `context ${Math.round(usage?.percent ?? 0)}%` : `${slot.tasks_done} tasks`);
			return;
		}
		runtime.claimNext(me);
	}

	function managerTick(me: AgentRow): void {
		const config = runtime.configOf(me);
		const now = Date.now();
		if (now - lastPatrolAt < config.patrol_minutes * 60_000) return;
		lastPatrolAt = now;
		runtime.patrol(me);
		if (me.role !== "personal") return;
		for (const row of runtime.registry.allHolders()) {
			if (row.status !== "parked") continue;
			runtime.patrol(row);
		}
	}

	function parkTick(ctx: ExtensionContext, me: AgentRow): void {
		if (stopping) return;
		if (me.role !== "project" && me.role !== "group") return;
		if (!process.env.OMP_TEAMS_PARK) return;
		const minutes = runtime.configOf(me).reclaim.idle_minutes[me.role];
		const limit = minutes > 0 ? minutes * 60_000 : 0;
		if (limit === 0) return;
		const now = Date.now();
		if (!ctx.isIdle() || ctx.hasPendingMessages()) {
			idleSince = 0;
			return;
		}
		if (idleSince === 0) {
			idleSince = now;
			return;
		}
		if (now - idleSince < limit) return;
		parkMember(ctx, me);
	}

	function parkMember(ctx: ExtensionContext, me: AgentRow): void {
		const parkFile = process.env.OMP_TEAMS_PARK;
		if (!parkFile) return;
		stopping = true;
		const failed = (reason: string): void => {
			stopping = false;
			idleSince = 0;
			logEvent(db, "park:failed", { reason }, me.id);
		};
		try {
			const parked = runtime.park(me);
			if (!parked.ok) {
				failed(parked.error);
				return;
			}
			const resume = me.session_file && existsSync(me.session_file) ? me.session_file : null;
			writeLaunchFile(parkFile, resume ? `${resume}\n` : "");
			logEvent(db, "park", { seat: me.seat, resume }, me.id);
			const paneId = me.pane_id ?? currentPaneId();
			if (paneId) herdr.renamePane(paneId, `${PARKED_GLYPH} ${me.label}`);
			ctx.shutdown();
		} catch (error) {
			failed(String(error));
		}
	}

	function renderPresence(ctx: ExtensionContext): void {
		const me = self;
		if (!me) return;
		const parent = me.parent_seat ? runtime.registry.holder(me.parent_seat) : null;
		const slot = me.role === "worker" ? runtime.slotOf(me) : null;
		const group = runtime.groupOf(me);
		const current = isManagerRole(me.role) ? null : runtime.currentTask(me);
		const guard = runtime.guard(me);
		const input = {
			agent: me,
			counts: runtime.counts(me),
			parentLabel: parent?.label ?? me.parent_seat,
			parentAlive: parent !== null,
			currentTaskId: current?.id ?? null,
			currentTaskTitle: current?.title ?? null,
			manual: slot?.manual === 1,
			branch: slot?.branch ?? group?.branch ?? null,
			paused: group?.paused === 1,
			integrator: slot?.kind === "integrator",
			halted: guard.halted,
			budgetSpent: guard.frozen,
		};

		const painter = ctx.hasUI ? themePainter(ctx) : undefined;
		const line = statusLine(input, painter);
		if (line !== lastStatus && ctx.hasUI) {
			ctx.ui.setStatus("teams", line);
			lastStatus = line;
		}

		if (isManagerRole(me.role) && ctx.hasUI) {
			const rows = widgetLines(runtime.progress(me), Date.now(), painter);
			const text = rows.join("\n");
			if (text !== lastWidget) {
				ctx.ui.setWidget("teams", rows, { placement: "aboveEditor" });
				lastWidget = text;
			}
		}

		const now = Date.now();
		if (now - lastMetadataAt < METADATA_INTERVAL_MS) return;
		lastMetadataAt = now;
		const paneId = me.pane_id ?? currentPaneId();
		if (!herdrAvailable() || !paneId) return;
		metadataSeq++;
		herdr.reportPresence(
			paneId,
			{
				displayAgent: me.label,
				stateLabels: paneStateLabels(input),
				tokens: { role: me.role, seat: me.seat, project: me.project_id ?? "-", group: me.group_name ?? "-" },
				seq: metadataSeq,
				ttlMs: 90_000,
			},
			paneTitle(input),
		);
	}

	function startTimer(ctx: ExtensionContext): void {
		if (timer) return;
		const period = runtime.configFor(runtime.registry.projectRoot(self?.project_id ?? "") ?? undefined).poll_ms;
		lastPatrolAt = Date.now();
		timer = ctx.setInterval(() => {
			const me = self;
			if (!me || stopping) return;
			runtime.registry.heartbeat(me.id);
			recordSpendTick(ctx, me);
			runtime.registry.sweepDead();
			self = runtime.me(sessionId ?? "") ?? runtime.registry.revive(me.id);
			if (!self) {
				if (timer) ctx.clearTimer(timer);
				timer = null;
				return;
			}
			renderPresence(ctx);
			void deliverInbox(ctx).then(() => {
				const current = self;
				if (!current || stopping) return;
				if (isManagerRole(current.role)) managerTick(current);
				else workerTick(ctx, current);
				parkTick(ctx, current);
			});
		}, Math.max(500, period));
	}

	async function autoJoin(ctx: ExtensionContext): Promise<void> {
		const raw = process.env.OMP_TEAMS_JOIN;
		if (!raw) return;
		const join = decodeJoin(raw);
		const role = join.role;
		if (role !== "personal" && role !== "project" && role !== "group" && role !== "worker") return;
		const project = role === "personal" ? null : resolveProject(ctx.cwd);
		const result = runtime.register(
			{
				role,
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile() ?? null,
				paneId: currentPaneId(),
				projectId: join.project ?? project?.id ?? null,
				projectName: project?.name ?? null,
				group: join.group ?? null,
				slotId: join.slot ?? null,
				takeoverPane: currentPaneId(),
			},
			project ? { project } : {},
		);
		if (!result.ok) {
			logEvent(db, "join:failed", { error: result.error, join });
			console.error(`[omp-teams] auto-join failed: ${result.error}`);
			return;
		}
		self = result.agent;
		logEvent(db, "join", { role, seat: result.agent.seat }, result.agent.id);
	}

	registerTeamsTools(pi, host, spawnDeps);
	registerTeamsCommands(pi, host, spawnDeps);

	pi.on("session_start", async (_event, ctx) => {
		activeCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		if (!baselineTools) baselineTools = pi.getActiveTools();
		self = runtime.me(sessionId);
		if (!self) {
			const previous = runtime.registry.lastRowOfSession(sessionId);
			if (previous) self = runtime.registry.revive(previous.id, { paneId: currentPaneId(), cwd: ctx.cwd });
		}
		if (!self) await autoJoin(ctx);
		if (!self) return;
		runtime.mailer.markAcked(persistedMsgIds(ctx.sessionManager.getBranch()));
		runtime.inheritOpenTasks(self);
		await applyToolPolicy();
		startTimer(ctx);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		if (!self) return;
		const slot = self.role === "worker" ? runtime.slotOf(self) : null;
		return {
			systemPrompt: [
				...ctx.getSystemPrompt(),
				systemPromptFor(self, {
					integrator: slot?.kind === "integrator",
					workplace: slot ? { worktree: slot.worktree, branch: slot.branch } : undefined,
				}),
			],
		};
	});

	pi.on("input", async (event) => {
		const me = self;
		if (!me || me.role !== "worker" || event.source !== "interactive") return;
		if (event.text.trim().startsWith("/teams")) return;
		const slot = runtime.slotOf(me);
		if (slot && slot.manual !== 1) {
			runtime.setManual(me, true);
			host.notify(`${me.label}: manual mode (you typed here). Run /teams release to hand it back.`, "info");
		}
	});

	function workerBounds(me: AgentRow): WorkerBounds | null {
		const slot = runtime.slotOf(me);
		if (!slot || !me.project_id) return null;
		const projectRoot = runtime.registry.projectRoot(me.project_id);
		const config = runtime.configOf(me);
		return {
			worktree: slot.worktree,
			branch: slot.branch,
			protectedRoots: [projectRoot, join(config.worktree_root, me.project_id)].filter((root): root is string => Boolean(root)),
		};
	}

	pi.on("tool_call", async (event) => {
		const me = self;
		if (!me) return;
		const seat = toolSeat(me);
		const reason =
			seat === "worker"
				? workerBlockReason(event.toolName, event.input, workerBounds(me))
				: leaderBlockReason(seat, event.toolName);
		if (reason) {
			logEvent(db, "block", { tool: event.toolName, role: me.role, reason }, me.id);
			return { block: true, reason };
		}
	});

	pi.on("session_shutdown", async () => {
		self = null;
	});
}
