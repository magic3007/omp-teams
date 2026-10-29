import type { Database } from "bun:sqlite";
import { configStamp, loadConfig, resolveModel, type TaskDifficulty, type TaskKind, type TeamsConfig } from "./config";
import { logEvent, teamsHome } from "./db";
import { formatUsd, guardState, readState, recordSpend, setState, spendToday } from "./guard";
import { projectSeat, type Role, sessionTag } from "./identity";
import { type MailBody, type MailKind, Mailer, type MailRow } from "./mail";
import { mergeIntoGroup } from "./merge";
import { isManagerRole } from "./policy";
import { ACTIVE_STATUSES, TaskQueue, type TaskRow, taskPaths, taskTitle } from "./queue";
import { type AgentRow, type GroupRow, type RegisterInput, type RegisterResult, Registry } from "./registry";
import { type SlotKind, type SlotRow, Slots } from "./slots";
import { findRepository } from "./repos";
import { launchTag, seatLaunchFiles, writeLaunchFile } from "./spawn";
import { branchHead, changedFiles, commitExists, currentBranch, isAncestor } from "./worktree";

export type { TaskRow };

export interface RuntimeOptions {
	db: Database;
	home?: string;
	now?: () => number;
	deadAfterMs?: number;
}

export interface RegisterExtras {
	project?: { id: string; name: string; root: string };
	group?: { worktree: string; branch: string; base?: string | null };
}

export interface AssignRequest {
	to?: string;
	task: string;
	kind: TaskKind;
	difficulty: TaskDifficulty;
	paths?: string[];
	model?: string;
	requireOpenTask?: boolean;
	parentTask?: string;
}

export type AssignResult =
	| { ok: true; taskId: string; model: string | null; to: AgentRow | null; queued: boolean }
	| { ok: false; error: string };

export interface ReportRequest {
	summary: string;
	status: "progress" | "done" | "blocked" | "failed";
	taskId?: string;
	sha?: string;
}

export type ReportResult =
	| { ok: true; msgId: string; to: AgentRow; followUp?: string }
	| { ok: false; error: string };

export interface ProgressEntry {
	agent: AgentRow;
	session: string;
	current: TaskRow | null;
	lastReport: { status: string; summary: string; at: number; taskId?: string } | null;
}

export type MergeOutcome = { ok: true; summary: string } | { ok: false; error: string };

export type CloseResult = { ok: true; closed: AgentRow[]; cancelled: string[] } | { ok: false; error: string };

export interface PatrolResult {
	inherited: string[];
	requeued: string[];
	abandoned: string[];
	blocked: string[];
	escalated: string[];
	stalled: string[];
	unpinned: string[];
	guards: string[];
	drained: boolean;
}

export const NO_OPEN_TASK =
	"you have no open task from your manager, so there is nothing to delegate. Report what you have with teams_report and wait for the next task.";

export const CLOSE_GRACE_MS = 120_000;

export function slotOfSeat(seat: string): string | null {
	return seat.startsWith("worker:") ? seat.slice("worker:".length) : null;
}

export class TeamsRuntime {
	readonly registry: Registry;
	readonly mailer: Mailer;
	readonly slots: Slots;
	readonly queue: TaskQueue;
	private readonly configs = new Map<string, { config: TeamsConfig; stamp: string }>();

	readonly home: string;
	readonly db: Database;

	constructor(private readonly options: RuntimeOptions) {
		this.home = options.home ?? teamsHome();
		this.db = options.db;
		const now = options.now ?? Date.now;
		this.registry = new Registry(options.db, {
			deadAfterMs: options.deadAfterMs ?? loadConfig(undefined, options.home).limits.dead_after_seconds * 1000,
			now,
		});
		this.mailer = new Mailer(options.db, now, (seat) => this.wakeSeat(seat));
		this.slots = new Slots(options.db, now);
		this.queue = new TaskQueue(options.db, now);
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	configFor(projectRoot?: string): TeamsConfig {
		const key = projectRoot ?? "";
		const stamp = configStamp(projectRoot, this.options.home);
		const cached = this.configs.get(key);
		if (cached && cached.stamp === stamp) return cached.config;
		const config = loadConfig(projectRoot, this.options.home);
		this.configs.set(key, { config, stamp });
		return config;
	}

	invalidateConfig(): void {
		this.configs.clear();
	}

	configOf(agent: AgentRow): TeamsConfig {
		return this.configFor(this.registry.projectRoot(agent.project_id ?? "") ?? undefined);
	}

	guard(agent: AgentRow | null): import("./guard").GuardState {
		const config = agent ? this.configOf(agent) : this.configFor(undefined);
		return guardState(this.options.db, config, this.now());
	}

	spendToday(): number {
		return spendToday(this.options.db, this.now());
	}

	recordUsage(
		agent: AgentRow,
		cost: number,
		options: { model?: string | null; tokens?: { input: number; output: number } } = {},
	): number {
		const model = options.model ?? agent.model;
		return recordSpend(this.options.db, {
			sessionId: agent.session_id,
			agentId: agent.id,
			seat: agent.seat,
			model,
			cost,
			tokens: options.tokens,
			config: this.configOf(agent),
			at: this.now(),
		});
	}

	halt(viewer: AgentRow, reason: string): { ok: true; paused: number } {
		setState(this.options.db, "halted", reason, this.now());
		let paused = 0;
		for (const group of this.registry.allGroups()) {
			if (group.paused === 1 && group.paused_reason === null) continue;
			this.registry.setGroupPaused(group.project_id, group.name, true, "halt");
			paused++;
		}
		this.broadcastNotice(viewer, `The team is halted: ${reason}`, "Finish only what is in flight; do not claim or assign new work. A human resumes with /teams resume.");
		logEvent(this.options.db, "halt", { reason, paused }, viewer.id, this.now());
		return { ok: true, paused };
	}

	resume(viewer: AgentRow): { ok: true; resumed: number; frozen: boolean; spendToday: number } {
		setState(this.options.db, "halted", null, this.now());
		let resumed = 0;
		for (const group of this.registry.allGroups()) {
			if (group.paused === 1 && group.paused_reason !== null) {
				this.registry.setGroupPaused(group.project_id, group.name, false);
				resumed++;
			}
		}
		const state = this.guard(viewer);
		this.broadcastNotice(
			viewer,
			state.frozen ? "The halt is lifted, but the daily budget is still spent" : "The team is running again",
			state.frozen
				? `Spend today is $${formatUsd(state.spendToday)} of $${formatUsd(state.budgetUsd)}; assign and spawn stay refused until the budget rises or a new day starts.`
				: "New tasks may be assigned and claimed.",
		);
		logEvent(this.options.db, "resume", { resumed, frozen: state.frozen }, viewer.id, this.now());
		return { ok: true, resumed, frozen: state.frozen, spendToday: state.spendToday };
	}

	requestFreshStatus(viewer: AgentRow): { ok: true; asked: string[] } | { ok: false; error: string } {
		const config = this.configOf(viewer);
		const limit = config.rate_limits.fresh_per_hour;
		const key = `fresh:${viewer.seat}`;
		const last = readState(this.options.db, key);
		const now = this.now();
		if (last && limit > 0) {
			const lastAt = Number(last);
			const waitMs = lastAt + (60 * 60_000) / Math.max(1, limit) - now;
			if (Number.isFinite(lastAt) && waitMs > 0) {
				return { ok: false, error: `a fresh status was requested ${Math.round((now - lastAt) / 60_000)} min ago; wait ${Math.ceil(waitMs / 60_000)} more min (rate_limits.fresh_per_hour ${limit}).` };
			}
		}
		const children = this.registry.childrenOf(viewer.seat);
		if (children.length === 0) return { ok: false, error: "no direct subordinates" };
		this.options.db.transaction(() => {
			for (const child of children) {
				this.mailer.send({
					fromAgent: viewer.id,
					fromSeat: viewer.seat,
					toSeat: child.seat,
					toAgent: child.id,
					kind: "ping",
					body: { text: "fresh status", fresh: true },
				});
			}
			setState(this.options.db, key, String(now), now);
			logEvent(this.options.db, "fresh", { asked: children.map((row) => row.seat) }, viewer.id, now);
		})();
		return { ok: true, asked: children.map((row) => row.label) };
	}

	stopReason(agent: AgentRow): string | null {
		return this.guard(agent).stopReason;
	}

	private broadcastNotice(viewer: AgentRow, text: string, detail: string): void {
		for (const member of this.registry.allAlive()) {
			if (member.id === viewer.id) continue;
			this.mailer.send({
				fromAgent: viewer.id,
				fromSeat: viewer.seat,
				toSeat: member.seat,
				toAgent: member.id,
				kind: "notice",
				body: { text: `${text}\n${detail}` },
			});
		}
	}

	me(sessionId: string): AgentRow | null {
		return this.registry.bySession(sessionId);
	}

	register(input: RegisterInput, extras: RegisterExtras = {}): RegisterResult {
		if (extras.project) {
			this.registry.upsertProject(extras.project.id, extras.project.name, extras.project.root);
		}
		if (extras.group && input.projectId && input.group) {
			this.registry.upsertGroup({
				projectId: input.projectId,
				name: input.group,
				worktree: extras.group.worktree,
				branch: extras.group.branch,
				base: extras.group.base ?? null,
				head: branchHead(extras.group.worktree),
			});
		}
		const config = this.configFor(extras.project?.root ?? this.registry.projectRoot(input.projectId ?? "") ?? undefined);
		let withSlot = input;
		if (input.role === "worker") {
			const slot = this.ensureWorkerSlot(input);
			withSlot = { ...input, slotId: slot.id, index: slot.index_no, slotKind: slot.kind };
		}
		const model =
			withSlot.model ??
			(withSlot.slotKind === "integrator"
				? (config.models.routing.by_kind.merge ?? config.models.role.integrator)
				: defaultModelForRole(config, withSlot.role));
		const result = this.registry.register({ ...withSlot, model });
		if (result.ok && result.agent.role === "worker") {
			const slotId = slotOfSeat(result.agent.seat);
			if (slotId) this.slots.occupy(slotId, result.agent.id, result.agent.session_id);
		}
		return result;
	}

	ensureWorkerSlot(input: RegisterInput, kind: SlotKind = "worker"): SlotRow {
		if (input.slotId) {
			const existing = this.slots.byId(input.slotId);
			if (existing) return existing;
		}
		const group = input.group ?? "";
		const bound = this.slots.byWorktree(input.cwd, kind);
		if (bound) return bound;
		const used = this.slots.forGroup(input.projectId ?? null, group, kind);
		const index = used.length + 1;
		const branch = currentBranch(input.cwd) ?? `teams-w/${group}/w${index}`;
		return this.slots.ensure({
			projectId: input.projectId ?? null,
			group,
			kind,
			index,
			worktree: input.cwd,
			branch,
		});
	}

	leave(agent: AgentRow): void {
		this.registry.markStatus(agent.id, "left");
	}

	retireSlot(agent: AgentRow): void {
		const slot = this.slotOf(agent);
		if (!slot) return;
		this.slots.setStatus(slot.id, "retired");
		this.leave(agent);
		logEvent(this.options.db, "retire", { slot: slot.id }, agent.id, this.now());
	}

	park(agent: AgentRow): { ok: true } | { ok: false; error: string } {
		return this.options.db
			.transaction((): { ok: true } | { ok: false; error: string } => {
				const pending = this.options.db
					.query("SELECT COUNT(*) AS n FROM messages WHERE to_seat = ? AND delivered_at IS NULL")
					.get(agent.seat) as { n: number };
				if (pending.n > 0) {
					return { ok: false, error: `${pending.n} undelivered message(s) wait for ${agent.seat}` };
				}
				const updated = this.options.db.run(
					"UPDATE agents SET status = 'parked', last_seen = ? WHERE id = ? AND status = 'alive'",
					[this.now(), agent.id],
				);
				if (updated.changes === 0) return { ok: false, error: `${agent.label} is not alive` };
				return { ok: true };
			})
			.immediate();
	}

	wakeSeat(seat: string): boolean {
		const holder = this.registry.holder(seat);
		if (!holder || holder.status !== "parked") return false;
		writeLaunchFile(seatLaunchFiles(this.home, holder.seat).wake, "");
		return true;
	}

	slotOf(agent: AgentRow): SlotRow | null {
		const slotId = slotOfSeat(agent.seat);
		return slotId ? this.slots.byId(slotId) : null;
	}

	worktreeFor(agent: AgentRow): string {
		return this.slotOf(agent)?.worktree ?? agent.cwd;
	}

	groupOf(agent: AgentRow): GroupRow | null {
		if (!agent.project_id || !agent.group_name) return null;
		return this.registry.group(agent.project_id, agent.group_name);
	}

	assign(viewer: AgentRow, request: AssignRequest): AssignResult {
		if (!isManagerRole(viewer.role)) {
			return { ok: false, error: `${viewer.label} is a ${viewer.role}; only managers assign tasks.` };
		}
		if (!request.task.trim()) return { ok: false, error: "the task text is empty." };
		const stopped = this.stopReason(viewer);
		if (stopped) return { ok: false, error: `new work cannot start: ${stopped}.` };
		if (request.kind === "merge") {
			return {
				ok: false,
				error:
					"merges are automatic: when a worker reports done with a SHA, the integrator merges it into the group branch. Do not assign merge tasks.",
			};
		}

		let target: AgentRow | null = null;
		if (request.to?.trim()) {
			target = this.registry.resolveRef(viewer, request.to);
			if (!target) {
				const options = this.registry
					.childrenOf(viewer.seat)
					.map((row) => `${row.label} (${row.id})`)
					.join(", ");
				return {
					ok: false,
					error: `cannot resolve "${request.to}". You may assign only to your direct subordinates: ${options || "none registered"}.`,
				};
			}
			if (target.parent_seat !== viewer.seat) {
				return {
					ok: false,
					error: `${target.label} is not your direct subordinate (cross-level assignment is not allowed). Assign to your direct subordinates only.`,
				};
			}
			if (this.slotOf(target)?.kind === "integrator") {
				return {
					ok: false,
					error: `${target.label} is the integrator; it only takes the merge tasks the system creates. Assign work to a worker or queue it.`,
				};
			}
		} else if (viewer.role !== "group") {
			return { ok: false, error: "`to` is required: only a group lead can put work on a queue." };
		}

		const held = viewer.role === "personal" ? [] : this.queue.heldAll(viewer.id, viewer.seat);
		const list = held.map((task) => `${task.id} (${task.title.slice(0, 60)})`).join(", ");
		let received: TaskRow | null = null;
		if (request.parentTask?.trim() && viewer.role !== "personal") {
			received = held.find((task) => task.id === request.parentTask?.trim()) ?? null;
			if (!received) {
				return { ok: false, error: `you do not hold task ${request.parentTask}. You hold: ${list || "nothing"}.` };
			}
		} else if (held.length === 1 || (held.length > 1 && !request.requireOpenTask)) {
			received = held[0] ?? null;
		} else if (held.length > 1) {
			return {
				ok: false,
				error: `you hold ${held.length} tasks: ${list}. Pass parent_task with the id of the one this work serves.`,
			};
		}
		if (request.requireOpenTask && viewer.role !== "personal" && !received) {
			return { ok: false, error: NO_OPEN_TASK };
		}

		const config = this.configOf(viewer);
		let model: string | null = null;
		if (!target || target.role === "worker") {
			const resolved = resolveModel(config, {
				kind: request.kind,
				difficulty: request.difficulty,
				model: request.model,
				paths: request.paths,
			});
			if ("error" in resolved) return { ok: false, error: resolved.error };
			model = resolved.model;
		} else if (request.model) {
			const resolved = resolveModel(config, { model: request.model });
			if ("error" in resolved) return { ok: false, error: resolved.error };
			model = resolved.model;
		}
		return this.options.db.transaction((): AssignResult => {
			if (received?.status === "blocked") this.queue.resume(received.id);
			if (received) this.queue.touch(received.id);

			const task = this.queue.create({
				projectId: viewer.project_id,
				group: target?.group_name ?? viewer.group_name,
				fromAgent: viewer.id,
				fromSeat: viewer.seat,
				toAgent: target?.id ?? null,
				toSeat: target?.seat ?? null,
				slotId: target ? slotOfSeat(target.seat) : null,
				body: request.task,
				kind: request.kind,
				difficulty: request.difficulty,
				model,
				paths: request.paths,
				status: target ? "assigned" : "queued",
				parentTask: received?.id ?? null,
			});

			if (target) this.sendTaskMail(task, viewer.id, viewer.seat, target.seat, target.id);
			logEvent(
				this.options.db,
				target ? "assign" : "enqueue",
				{ taskId: task.id, to: target?.id ?? null, model },
				viewer.id,
				this.now(),
			);
			return { ok: true, taskId: task.id, model, to: target, queued: !target };
		})();
	}

	private sendTaskMail(task: TaskRow, fromAgent: string, fromSeat: string, toSeat: string, toAgent: string | null): string {
		return this.mailer.send({
			fromAgent,
			fromSeat,
			toSeat,
			toAgent,
			kind: "task",
			taskId: task.id,
			body: {
				task_id: task.id,
				title: task.title,
				kind: task.kind,
				difficulty: task.difficulty,
				model: task.model ?? undefined,
				paths: taskPaths(task),
				text: task.body,
			},
		});
	}

	claimNext(worker: AgentRow): TaskRow | null {
		if (worker.role !== "worker") return null;
		const slot = this.slotOf(worker);
		if (slot?.kind !== "integrator" && this.stopReason(worker)) return null;
		if (!slot || slot.manual === 1 || slot.status !== "occupied") return null;
		const group = this.groupOf(worker);
		if (!group || group.paused === 1) return null;
		if (this.queue.current(worker.id, worker.seat)) return null;

		return this.options.db.transaction((): TaskRow | null => {
			const task = this.queue.claim(
				{ projectId: worker.project_id, group: worker.group_name },
				{ agentId: worker.id, slotId: slot.id, seat: worker.seat, merge: slot.kind === "integrator" },
			);
			if (!task) return null;
			this.sendTaskMail(task, task.from_agent, task.from_seat ?? worker.parent_seat ?? worker.seat, worker.seat, worker.id);
			logEvent(this.options.db, "claim", { taskId: task.id, slot: slot.id }, worker.id, this.now());
			return task;
		})();
	}

	taskDelivered(taskId: string, worker: AgentRow): void {
		this.queue.markRunning(taskId, { agentId: worker.id, slotId: slotOfSeat(worker.seat) });
	}

	inheritOpenTasks(agent: AgentRow): TaskRow[] {
		return this.options.db.transaction((): TaskRow[] => {
			const inherited = this.queue.heldByPredecessor(agent.seat, agent.id);
			for (const task of inherited) {
				this.queue.inherit(task.id, agent.id, task.attempts);
				const fresh = this.queue.byId(task.id);
				if (fresh) this.sendTaskMail(fresh, fresh.from_agent, fresh.from_seat ?? agent.parent_seat ?? agent.seat, agent.seat, agent.id);
				logEvent(this.options.db, "inherit", { taskId: task.id }, agent.id, this.now());
			}
			return inherited;
		})();
	}

	report(viewer: AgentRow, request: ReportRequest): ReportResult {
		if (!viewer.parent_seat) {
			return { ok: false, error: `${viewer.label} has no manager to report to.` };
		}
		const parent = this.registry.holder(viewer.parent_seat);
		if (!parent) {
			return {
				ok: false,
				error: `manager ${viewer.parent_seat} is not registered. Ask a human to register it, then retry.`,
			};
		}

		if (request.sha) {
			const dir = this.worktreeFor(viewer);
			if (!commitExists(dir, request.sha)) {
				return { ok: false, error: `sha ${request.sha} is not a commit in ${dir}; commit your work first, then report the SHA` };
			}
			if (this.slotOf(viewer)?.kind === "worker" && !isAncestor(dir, request.sha, "HEAD")) {
				return { ok: false, error: `sha ${request.sha} is not on your branch in ${dir}; report the SHA of your own commit (git rev-parse HEAD).` };
			}
		}

		return this.options.db.transaction((): ReportResult => {
			let followUp: string | undefined;
			let evidence: string[] = [];
			if (request.taskId) {
				const task = this.queue.byId(request.taskId);
				if (!task) return { ok: false, error: `task ${request.taskId} not found.` };
				if (task.to_agent !== viewer.id && task.to_seat !== viewer.seat) {
					return { ok: false, error: `task ${request.taskId} is not assigned to ${viewer.label}.` };
				}
				if (task.status === "cancelled") {
					return { ok: false, error: `task ${request.taskId} was closed upstream; stop working on it and do not report on it.` };
				}
				if (task.status !== "done") followUp = this.applyReport(viewer, task, request);
				if (request.status === "done" && (viewer.role === "group" || viewer.role === "project")) {
					const work = this.queue.descendants(task.id).filter((row) => row.status !== "failed" && row.status !== "cancelled");
					evidence = this.deliveredGroups(viewer, task, work).map((group) => this.groupEvidence(group));
				}
			}

			const summary = [
				request.summary,
				evidence.length > 0 ? `Delivered (checked by the system):\n${evidence.join("\n")}` : null,
				followUp ?? null,
			]
				.filter((part): part is string => Boolean(part))
				.join("\n\n");
			const msgId = this.mailer.send({
				fromAgent: viewer.id,
				fromSeat: viewer.seat,
				toSeat: parent.seat,
				toAgent: parent.id,
				kind: "report",
				taskId: request.taskId ?? null,
				body: { status: request.status, summary, task_id: request.taskId, sha: request.sha },
			});
			return { ok: true, msgId, to: parent, followUp };
		})();
	}

	private applyReport(viewer: AgentRow, task: TaskRow, request: ReportRequest): string | undefined {
		const config = this.configOf(viewer);
		const slot = this.slotOf(viewer);
		switch (request.status) {
			case "progress":
				this.queue.touch(task.id);
				this.queue.resume(task.id);
				return undefined;
			case "blocked":
				this.queue.block(task.id);
				return undefined;
			case "failed": {
				if (slot?.kind === "analyst") {
					this.queue.failTerminal(task.id);
					this.slots.setStatus(slot.id, "retiring");
					return `task ${task.id} failed; the analyst is closed and its worktree removed.`;
				}
				const outcome = this.queue.fail(task.id, config.max_task_failures);
				return outcome.status === "queued"
					? `task ${task.id} returned to the queue (attempt ${outcome.attempts} of ${config.max_task_failures}).`
					: `task ${task.id} is blocked after ${outcome.attempts} failed attempts; it needs a decision.`;
			}
			case "done": {
				this.queue.done(task.id, request.sha ?? null);
				const cancelled = this.cancelOpenDescendants(task, viewer);
				if (slot) this.slots.incrementDone(slot.id);
				if (slot?.kind === "analyst") this.slots.setStatus(slot.id, "retiring");
				const note = cancelled > 0 ? `${cancelled} open task(s) under ${task.id} were cancelled.` : undefined;
				if (!request.sha || task.kind === "merge" || viewer.role !== "worker" || slot?.kind !== "worker") return note;
				const merge = this.enqueueMerge(viewer, task, request.sha);
				if (merge) return `merge ${merge.id} queued for the integrator.`;
				const integrated = task.project_id && task.group_name ? this.registry.group(task.project_id, task.group_name) : null;
				if (integrated && isAncestor(integrated.worktree, request.sha, "HEAD")) return note;
				return [note, `${request.sha.slice(0, 12)} is not merged: group ${task.group_name ?? "?"} has no integrator; merge it by hand.`]
					.filter(Boolean)
					.join(" ");
			}
		}
	}

	private cancelOpenDescendants(task: TaskRow, closer: AgentRow): number {
		const cancelled = this.queue.cancelOpen(this.queue.descendants(task.id));
		for (const row of cancelled) {
			if (!row.to_seat) continue;
			this.mailer.send({
				fromAgent: row.from_agent,
				fromSeat: row.from_seat ?? closer.seat,
				toSeat: row.to_seat,
				toAgent: row.to_agent,
				kind: "cancel",
				taskId: row.id,
				body: {
					task_id: row.id,
					text: `Task ${row.id} (${row.title}) is cancelled: ${task.id} above it was reported done by ${closer.label}. Stop working on it and do not report on it.`,
				},
			});
		}
		if (cancelled.length > 0) {
			logEvent(this.options.db, "cascade:cancel", { root: task.id, cancelled: cancelled.map((row) => row.id) }, closer.id, this.now());
		}
		return cancelled.length;
	}

	private enqueueMerge(worker: AgentRow, task: TaskRow, sha: string): TaskRow | null {
		if (!task.project_id || !task.group_name) return null;
		const integrator = this.slots.integratorFor(task.project_id, task.group_name);
		if (!integrator) return null;
		const group = this.registry.group(task.project_id, task.group_name);
		if (group && isAncestor(group.worktree, sha, "HEAD")) return null;
		const groupSeat = worker.parent_seat;
		if (!groupSeat) return null;
		const lead = this.registry.holder(groupSeat);
		const config = this.configOf(worker);
		const resolved = resolveModel(config, { kind: "merge", difficulty: "trivial" });
		const model = "error" in resolved ? null : resolved.model;
		const merge = this.queue.create({
			projectId: task.project_id,
			group: task.group_name,
			fromAgent: lead?.id ?? worker.id,
			fromSeat: groupSeat,
			body: [
				`Merge ${sha.slice(0, 12)} from ${worker.label} into the group branch.`,
				`Source task ${task.id}: ${task.title}`,
			].join("\n"),
			kind: "merge",
			difficulty: "trivial",
			model,
			status: "queued",
			parentTask: task.id,
			sourceSlot: slotOfSeat(worker.seat),
			sourceSha: sha,
		});
		logEvent(this.options.db, "merge:queued", { mergeTask: merge.id, source: task.id, sha }, worker.id, this.now());
		return merge;
	}

	merge(integrator: AgentRow, taskId: string): MergeOutcome {
		const slot = this.slotOf(integrator);
		if (!slot || slot.kind !== "integrator") {
			return { ok: false, error: `${integrator.label} is not the group integrator; only the integrator merges.` };
		}
		const task = this.queue.byId(taskId);
		if (!task || task.kind !== "merge") return { ok: false, error: `${taskId} is not a merge task.` };
		if (task.to_agent !== integrator.id && task.to_seat !== integrator.seat) {
			return { ok: false, error: `${taskId} is not assigned to ${integrator.label}.` };
		}
		if (!ACTIVE_STATUSES.includes(task.status)) {
			return { ok: false, error: `${taskId} is ${task.status}, not open.` };
		}
		const group = this.groupOf(integrator);
		if (!group) return { ok: false, error: "the integrator is not bound to a group." };
		if (!task.source_sha) return { ok: false, error: `${taskId} has no source commit.` };
		const sourceShort = task.source_sha.slice(0, 12);

		const config = this.configOf(integrator);
		const sourceSlot = task.source_slot ? this.slots.byId(task.source_slot) : null;
		const sourceLabel = sourceSlot ? `worker ${sourceSlot.index_no} · ${sourceSlot.group_name ?? ""}` : "a worker";

		const actualHead = branchHead(group.worktree);
		if (group.head_sha && actualHead && actualHead !== group.head_sha) {
			const summary = `${group.branch} moved outside the integrator (expected ${group.head_sha.slice(0, 12)}, found ${actualHead.slice(0, 12)}). Merges are on hold until a human checks the branch and runs /teams accept-head ${group.name}.`;
			this.options.db.transaction(() => {
				this.queue.block(task.id);
				this.report(integrator, { status: "blocked", summary });
				logEvent(this.options.db, "merge:head-mismatch", { expected: group.head_sha, actual: actualHead }, integrator.id, this.now());
			})();
			return { ok: true, summary };
		}

		const result = mergeIntoGroup(
			group.worktree,
			task.source_sha,
			`teams: merge ${task.parent_task ?? task.id} from ${sourceLabel}`,
			{ verifyCommand: config.merge.verify_command, verifyTimeoutMs: config.merge.verify_timeout_seconds * 1000 },
		);

		return this.options.db.transaction((): MergeOutcome => {
			let summary: string;
			let status: ReportRequest["status"];
			switch (result.kind) {
				case "merged":
				case "already-merged": {
					this.queue.done(task.id, result.sha);
					if (integrator.project_id && integrator.group_name) {
						this.registry.setGroupHead(integrator.project_id, integrator.group_name, result.sha);
					}
					this.slots.incrementDone(slot.id);
					status = "done";
					summary = `${sourceShort} from ${sourceLabel} is in ${group.branch} at ${result.sha.slice(0, 12)}${
						result.kind === "merged" && result.verified ? " (verified)" : ""
					}.`;
					break;
				}
				case "conflict":
				case "verify-failed": {
					this.queue.failTerminal(task.id);
					const detail =
						result.kind === "conflict"
							? `Merging it into ${group.branch} conflicts in: ${result.files.join(", ")}.`
							: `After merging it into ${group.branch}, verification failed:\n${result.output}`;
					const followUp = this.queue.create({
						projectId: task.project_id,
						group: task.group_name,
						fromAgent: task.from_agent,
						fromSeat: task.from_seat ?? integrator.parent_seat ?? integrator.seat,
						body: [
							`Rework your commit ${sourceShort} (task ${task.parent_task ?? "-"}) so it merges cleanly.`,
							detail,
							`Rebase your branch onto ${group.branch} (\`git rebase ${group.branch}\`), resolve the problem, run the tests, commit, then report done with the new SHA.`,
						].join("\n\n"),
						kind: "fix",
						difficulty: "normal",
						model: (() => {
							const resolved = resolveModel(config, { kind: "fix", difficulty: "normal" });
							return "error" in resolved ? null : resolved.model;
						})(),
						status: "queued",
						parentTask: task.parent_task,
						pinSlot: task.source_slot,
					});
					if (integrator.project_id && integrator.group_name) {
						this.registry.setGroupHead(integrator.project_id, integrator.group_name, actualHead);
					}
					status = "progress";
					summary = `${result.kind === "conflict" ? "conflict" : "verification failure"} merging ${sourceShort} from ${sourceLabel}; sent back as ${followUp.id}.`;
					break;
				}
				case "error":
					this.queue.block(task.id);
					status = "blocked";
					summary = `merge ${task.id} failed: ${result.error}`;
					break;
			}

			const reported = this.report(integrator, { summary, status, taskId: undefined });
			logEvent(this.options.db, `merge:${result.kind}`, { taskId: task.id, sha: task.source_sha }, integrator.id, this.now());
			if (!reported.ok) return { ok: true, summary: `${summary} (report not delivered: ${reported.error})` };
			return { ok: true, summary };
		})();
	}

	ask(viewer: AgentRow, to: string, question: string): { ok: true; msgId: string } | { ok: false; error: string } {
		const target = this.registry.resolveRef(viewer, to);
		if (!target) {
			const options = this.registry
				.visibleTo(viewer)
				.filter((row) => row.id !== viewer.id)
				.map((row) => `${row.label} (${row.id})`)
				.join(", ");
			return { ok: false, error: `cannot resolve "${to}". You may reach: ${options || "nobody yet"}.` };
		}
		const msgId = this.mailer.send({
			fromAgent: viewer.id,
			fromSeat: viewer.seat,
			toSeat: target.seat,
			toAgent: target.id,
			kind: "ask",
			body: { text: question },
		});
		return { ok: true, msgId };
	}

	taskById(taskId: string): TaskRow | null {
		return this.queue.byId(taskId);
	}

	progress(viewer: AgentRow): ProgressEntry[] {
		const reports = this.mailer.recentReports(viewer.seat);
		const pool = this.sessionPool();
		return this.registry.childrenOf(viewer.seat).map((agent) => {
			const latest = reports.find((row) => row.from_seat === agent.seat) ?? null;
			return {
				agent,
				session: sessionTag(agent.session_id, pool),
				current: this.queue.current(agent.id, agent.seat),
				lastReport: latest ? describeReport(latest) : null,
			};
		});
	}

	sessionPool(): string[] {
		return this.registry.allHolders().map((row) => row.session_id);
	}

	pause(viewer: AgentRow, groupName: string, paused: boolean): { ok: true } | { ok: false; error: string } {
		const allowed =
			(viewer.role === "personal" && viewer.project_id === null) ||
			(viewer.role === "project" && viewer.project_id !== null) ||
			(viewer.role === "group" && viewer.group_name === groupName);
		if (!allowed) return { ok: false, error: `${viewer.label} cannot pause group ${groupName}.` };
		const found = viewer.project_id ? null : this.registry.groupByName(groupName);
		if (viewer.project_id === null && !found) return { ok: false, error: `group ${groupName} is not registered.` };
		if (found?.ambiguous) return { ok: false, error: `several projects have a group named ${groupName}; ask that project's lead instead.` };
		const projectId = viewer.project_id ?? found?.group.project_id ?? "";
		const group = this.registry.group(projectId, groupName);
		if (!group) return { ok: false, error: `group ${groupName} is not registered.` };
		this.registry.setGroupPaused(projectId, groupName, paused);
		logEvent(this.options.db, paused ? "group:pause" : "group:resume", { group: groupName }, viewer.id, this.now());
		return { ok: true };
	}

	retire(viewer: AgentRow, ref: string): { ok: true; slot: SlotRow; agent: AgentRow | null } | { ok: false; error: string } {
		if (viewer.role !== "group") return { ok: false, error: "only a group lead retires workers." };
		const target = this.registry.resolveRef(viewer, ref);
		if (!target || target.parent_seat !== viewer.seat || target.role !== "worker") {
			return { ok: false, error: `"${ref}" is not one of your workers.` };
		}
		const slot = this.slotOf(target);
		if (!slot) return { ok: false, error: `${target.label} has no slot.` };
		if (slot.kind === "integrator") {
			return { ok: false, error: `${target.label} is the integrator; it stays as long as the group does.` };
		}
		this.slots.setStatus(slot.id, "retiring");
		logEvent(this.options.db, "retire:requested", { slot: slot.id }, viewer.id, this.now());
		return { ok: true, slot, agent: target };
	}

	close(viewer: AgentRow, ref: string): CloseResult {
		if (!isManagerRole(viewer.role)) return { ok: false, error: `${viewer.label} is a ${viewer.role}; only leaders close members.` };
		const target = this.closeTarget(viewer, ref.trim());
		if (typeof target === "string") return { ok: false, error: target };
		const members = [target, ...this.registry.subtreeOf(target.seat)];
		const seats = [...new Set(members.map((row) => row.seat))];
		const ids = members.map((row) => row.id);
		const cancelled = this.options.db
			.transaction((): TaskRow[] => {
				const marks = (values: string[]) => values.map(() => "?").join(", ");
				const open = this.options.db
					.query(
						`SELECT * FROM tasks WHERE status IN ('queued','assigned','claimed','running','blocked')
						 AND (to_seat IN (${marks(seats)}) OR to_agent IN (${marks(ids)}) OR from_seat IN (${marks(seats)}))`,
					)
					.all(...seats, ...ids, ...seats) as TaskRow[];
				const done = this.queue.cancelOpen(open);
				for (const member of members) this.registry.markStatus(member.id, "left");
				for (const seat of seats) {
					const slotId = slotOfSeat(seat);
					if (slotId) this.slots.setStatus(slotId, "retired");
				}
				this.mailer.discardInbox(seats);
				logEvent(this.options.db, "close", { target: target.seat, seats, cancelled: done.map((row) => row.id) }, viewer.id, this.now());
				return done;
			})
			.immediate();
		for (const seat of seats) {
			if (!launchTag(seat)) continue;
			const files = seatLaunchFiles(this.home, seat);
			writeLaunchFile(files.stop, `${this.now()}\n`);
			if (members.some((row) => row.seat === seat && row.status === "parked")) writeLaunchFile(files.wake, "");
		}
		return { ok: true, closed: members, cancelled: cancelled.map((row) => row.id) };
	}

	private closeTarget(viewer: AgentRow, ref: string): AgentRow | string {
		const resolved = this.registry.resolveRef(viewer, ref);
		if (resolved && resolved.parent_seat === viewer.seat) return resolved;
		const listed = this.registry.childrenOf(viewer.seat).map((row) => `${row.label} (${row.id})`).join(", ") || "none";
		if (viewer.role !== "personal" || !ref) return `"${ref}" is not one of your direct reports: ${listed}.`;
		const config = this.configOf(viewer);
		const found = findRepository(ref, { registered: this.registry.allProjects(), roots: config.repos.roots, depth: config.repos.depth });
		if (!found.ok) return `${found.error} Your direct reports: ${listed}.`;
		return this.registry.holder(projectSeat(found.project.id)) ?? `${found.project.name} has no repo leader to close.`;
	}

	setManual(worker: AgentRow, manual: boolean): { ok: true } | { ok: false; error: string } {
		const slot = this.slotOf(worker);
		if (!slot) return { ok: false, error: "takeover applies to workers only." };
		this.slots.setManual(slot.id, manual);
		logEvent(this.options.db, manual ? "takeover" : "release", { slot: slot.id }, worker.id, this.now());
		return { ok: true };
	}

	patrol(manager: AgentRow): PatrolResult {
		const result: PatrolResult = {
			inherited: [],
			requeued: [],
			abandoned: [],
			blocked: [],
			escalated: [],
			stalled: [],
			unpinned: [],
			guards: [],
			drained: false,
		};
		if (!isManagerRole(manager.role)) return result;
		const config = this.configOf(manager);
		const now = this.now();
		this.applyBudgetBrake(manager, config);
		this.registry.sweepDead();

		const issued = this.queue.issuedBy(manager.seat, ["queued", "assigned", "claimed", "running", "blocked", "done", "failed"]);
		for (const task of issued) {
			if (ACTIVE_STATUSES.includes(task.status) && task.to_agent) {
				const owner = this.registry.byId(task.to_agent);
				if (owner && owner.status !== "alive" && owner.status !== "parked") {
					const holder = task.to_seat ? this.registry.holder(task.to_seat) : null;
					if (holder && holder.id !== task.to_agent) {
						this.options.db.transaction(() => {
							this.queue.inherit(task.id, holder.id, task.attempts + 1);
							const fresh = this.queue.byId(task.id);
							if (fresh) this.sendTaskMail(fresh, manager.id, manager.seat, holder.seat, holder.id);
						})();
						result.inherited.push(task.id);
					} else if (task.kind === "analysis" && task.to_seat) {
						const seat = task.to_seat;
						this.options.db.transaction(() => {
							this.queue.failTerminal(task.id);
							this.slots.setStatus(slotOfSeat(seat) ?? "", "retired");
							this.mailer.send({
								fromAgent: manager.id,
								fromSeat: manager.seat,
								toSeat: manager.seat,
								toAgent: manager.id,
								kind: "notice",
								taskId: task.id,
								body: { text: `The analyst of ${task.id} (${task.title}) is gone and the task failed. Forward the task you hold again to start a new analyst.` },
							});
						})();
						if (launchTag(seat)) writeLaunchFile(seatLaunchFiles(this.home, seat).stop, `${now}\n`);
						result.abandoned.push(task.id);
					} else if (task.status === "assigned" && task.to_seat) {
						this.queue.reassignToSeat(task.id, task.attempts);
					} else {
						const outcome = this.queue.fail(task.id, config.max_task_failures);
						(outcome.status === "queued" ? result.requeued : result.blocked).push(task.id);
					}
					continue;
				}
				if (task.status === "running" && !task.escalated_at && now - task.updated_at > config.stall_minutes * 60_000) {
					this.options.db.transaction(() => {
						this.mailer.send({
							fromAgent: manager.id,
							fromSeat: manager.seat,
							toSeat: manager.seat,
							toAgent: manager.id,
							kind: "notice",
							taskId: task.id,
							body: {
								text: `Task ${task.id} (${task.title}) has run for ${Math.round((now - task.updated_at) / 60_000)} minutes without a report from ${owner?.label ?? task.to_agent}. Ask with teams_ask, or decide whether to re-scope it.`,
							},
						});
						this.queue.markEscalated(task.id);
					})();
					result.stalled.push(task.id);
				}
			}
			if (task.status === "queued" && task.pin_slot) {
				const pinned = this.slots.byId(task.pin_slot);
				if (!pinned || pinned.status === "retired") {
					this.options.db.run("UPDATE tasks SET pin_slot = NULL WHERE id = ?", [task.id]);
					result.unpinned.push(task.id);
				}
			}
		}

		const blocked = this.queue.issuedBy(manager.seat, ["blocked"]).filter((task) => !task.escalated_at);
		for (const task of blocked) {
			this.options.db.transaction(() => {
				this.queue.markEscalated(task.id);
				if (!manager.parent_seat) return;
				const reported = this.report(manager, {
					status: "blocked",
					summary: `${task.id} (${task.title}) is blocked after ${task.attempts} attempt(s) and needs a decision.`,
				});
				if (reported.ok) result.escalated.push(task.id);
			})();
		}

		if (manager.role === "group" && manager.project_id && manager.group_name) {
			if (this.blockedRateGuard(manager, config)) result.guards.push(`blocked-rate:${manager.group_name}`);
		}

		result.drained = this.closeIfDrained(manager);
		if (result.inherited.length + result.requeued.length + result.abandoned.length + result.blocked.length + result.escalated.length + result.guards.length > 0) {
			logEvent(this.options.db, "patrol", result, manager.id, now);
		}
		return result;
	}

	private applyBudgetBrake(manager: AgentRow, config: TeamsConfig): void {
		const state = this.guard(manager);
		if (state.frozen) {
			let paused = 0;
			for (const group of this.registry.allGroups()) {
				if (group.paused === 1 && group.paused_reason === "budget") continue;
				if (group.paused === 1 && group.paused_reason !== null) {
					this.registry.setGroupPaused(group.project_id, group.name, true, "budget");
					continue;
				}
				if (group.paused === 1) continue;
				this.registry.setGroupPaused(group.project_id, group.name, true, "budget");
				paused++;
			}
			if (paused > 0) {
				logEvent(this.options.db, "guard:budget", { spend: state.spendToday, limit: state.budgetUsd, paused }, manager.id, this.now());
				this.report(manager, {
					status: "blocked",
					summary: `daily budget reached: $${formatUsd(state.spendToday)} of $${formatUsd(state.budgetUsd)}. All groups are paused; raise guards.budget.daily_usd or wait for tomorrow.`,
				});
			}
			return;
		}
		for (const group of this.registry.allGroups()) {
			if (group.paused === 1 && group.paused_reason === "budget") {
				this.registry.setGroupPaused(group.project_id, group.name, false);
				logEvent(this.options.db, "guard:budget-lifted", { group: group.name }, manager.id, this.now());
			}
		}
	}

	private blockedRateGuard(manager: AgentRow, config: TeamsConfig): boolean {
		const limit = config.guards.group_blocked_per_hour;
		if (limit <= 0 || !manager.project_id || !manager.group_name) return false;
		const group = this.registry.group(manager.project_id, manager.group_name);
		if (!group || group.paused_reason === "blocked-rate") return false;
		const since = this.now() - 60 * 60_000;
		const row = this.options.db
			.query(
				`SELECT COUNT(*) AS n FROM messages WHERE kind = 'report' AND task_id IN
				 (SELECT id FROM tasks WHERE project_id = ? AND group_name = ?) AND created_at >= ?
				 AND json_extract(body, '$.status') = 'blocked'`,
			)
			.get(manager.project_id, manager.group_name, since) as { n: number } | null;
		const count = row?.n ?? 0;
		if (count < limit) return false;
		const summary = `group ${manager.group_name} produced ${count} blocked report(s) in the last hour (limit ${limit}); it is paused and needs a human. Resume it with /teams resume ${manager.group_name} once the cause is fixed.`;
		this.options.db.transaction(() => {
			this.registry.setGroupPaused(group.project_id, group.name, true, "blocked-rate");
			this.report(manager, { status: "blocked", summary });
			logEvent(this.options.db, "guard:blocked-rate", { group: group.name, count, limit }, manager.id, this.now());
		})();
		return true;
	}

	private closeIfDrained(manager: AgentRow): boolean {
		if (!manager.parent_seat) return false;
		let closed = false;
		const active = this.queue
			.heldAll(manager.id, manager.seat)
			.filter((task) => ACTIVE_STATUSES.includes(task.status))
			.reverse();
		for (const received of active) {
			const work = this.queue.descendants(received.id).filter((task) => task.status !== "failed" && task.status !== "cancelled");
			if (work.length === 0 || work.some((task) => task.status !== "done")) continue;
			if (this.now() - Math.max(...work.map((task) => task.updated_at)) < CLOSE_GRACE_MS) continue;
			const head = manager.role === "group" ? branchHead(this.groupOf(manager)?.worktree ?? this.worktreeFor(manager)) : null;
			const answers = work
				.filter((task) => task.kind === "analysis" && task.parent_task === received.id)
				.map((task) => {
					const report = this.mailer.latestReport(task.id);
					return report ? `Answer from ${task.id}:\n${describeReport(report).summary}` : null;
				})
				.filter((answer): answer is string => answer !== null);
			const reported = this.report(manager, {
				taskId: received.id,
				status: "done",
				sha: head ?? undefined,
				summary: [`all ${work.length} task(s) created for ${received.id} are done.`, ...answers].join("\n\n"),
			});
			if (reported.ok) closed = true;
		}
		return closed;
	}

	private deliveredGroups(manager: AgentRow, received: TaskRow, work: TaskRow[]): GroupRow[] {
		if (manager.role === "group") {
			const own = this.groupOf(manager);
			return own ? [own] : [];
		}
		const names = new Set(
			work
				.filter((task) => task.parent_task === received.id && task.to_seat?.startsWith("group:") && task.group_name)
				.map((task) => task.group_name as string),
		);
		const projectId = manager.project_id;
		if (!projectId) return [];
		return [...names].map((name) => this.registry.group(projectId, name)).filter((group): group is GroupRow => group !== null);
	}

	private groupEvidence(group: GroupRow): string {
		const head = branchHead(group.worktree);
		const base = group.base ?? "main";
		const files = changedFiles(group.worktree, base, "HEAD");
		const listed =
			files === null
				? "unknown (git diff failed)"
				: files.length === 0
					? "none"
					: `${files.slice(0, 20).join(", ")}${files.length > 20 ? ` … ${files.length - 20} more` : ""}`;
		return `- ${group.branch} at ${head ?? "?"}; changes against ${base}: ${listed}`;
	}

	acceptHead(viewer: AgentRow, groupName: string): { ok: true; head: string } | { ok: false; error: string } {
		if (!(viewer.role === "project" || viewer.role === "personal" || (viewer.role === "group" && viewer.group_name === groupName))) {
			return { ok: false, error: `${viewer.label} cannot accept the head of group ${groupName}.` };
		}
		const found = viewer.project_id ? null : this.registry.groupByName(groupName);
		if (viewer.project_id === null && !found) return { ok: false, error: `group ${groupName} is not registered.` };
		if (found?.ambiguous) return { ok: false, error: `several projects have a group named ${groupName}.` };
		const projectId = viewer.project_id ?? found?.group.project_id ?? "";
		const group = this.registry.group(projectId, groupName);
		if (!group) return { ok: false, error: `group ${groupName} is not registered.` };
		const head = branchHead(group.worktree);
		if (!head) return { ok: false, error: `cannot read the head of ${group.worktree}.` };
		this.registry.setGroupHead(projectId, groupName, head);
		for (const task of this.queue.list({ projectId, group: groupName }, ["blocked"])) {
			if (task.kind === "merge") this.queue.requeue(task.id);
		}
		logEvent(this.options.db, "merge:accept-head", { group: groupName, head }, viewer.id, this.now());
		return { ok: true, head };
	}

	counts(agent: AgentRow): {
		projects: number;
		groups: number;
		workers: number;
		queued: number;
		running: number;
		done: number;
		blocked: number;
		unread: number;
		parked: number;
	} {
		const members = this.registry.allHolders();
		const inScope = (row: AgentRow): boolean => {
			if (agent.role === "personal") return true;
			if (!agent.project_id) return false;
			if (row.project_id !== agent.project_id) return false;
			if (agent.role === "project") return true;
			return row.group_name === agent.group_name;
		};
		const scoped = members.filter(inScope);
		const taskRows = this.options.db
			.query(
				`SELECT status, COUNT(*) AS n FROM tasks
				 WHERE (? IS NULL OR project_id IS ?) AND (? IS NULL OR group_name IS ?)
				 GROUP BY status`,
			)
			.all(agent.project_id ?? null, agent.project_id ?? null, agent.group_name ?? null, agent.group_name ?? null) as {
			status: string;
			n: number;
		}[];
		const countOf = (status: string): number => taskRows.find((row) => row.status === status)?.n ?? 0;
		const unread = this.options.db
			.query("SELECT COUNT(*) AS n FROM messages WHERE to_seat = ? AND delivered_at IS NULL")
			.get(agent.seat) as { n: number };
		const integratorSlots = new Set(
			(this.options.db.query("SELECT id FROM slots WHERE kind = 'integrator'").all() as { id: string }[]).map((row) => row.id),
		);
		return {
			projects: scoped.filter((row) => row.role === "project").length,
			groups: scoped.filter((row) => row.role === "group").length,
			workers: scoped.filter((row) => row.role === "worker" && !integratorSlots.has(slotOfSeat(row.seat) ?? "")).length,
			queued: countOf("queued") + countOf("assigned") + countOf("claimed"),
			running: countOf("running"),
			done: countOf("done"),
			blocked: countOf("blocked"),
			unread: unread.n,
			parked: scoped.filter((row) => row.status === "parked").length,
		};
	}

	currentTask(agent: AgentRow): TaskRow | null {
		return this.queue.current(agent.id, agent.seat);
	}

	heldTask(agent: AgentRow): TaskRow | null {
		return this.queue.held(agent.id, agent.seat);
	}

	forwardable(agent: AgentRow): TaskRow[] {
		return this.queue
			.heldAll(agent.id, agent.seat)
			.filter((task) => this.queue.children(task.id).every((child) => child.status === "cancelled" || child.status === "failed"));
	}

	queueText(agent: AgentRow): string {
		const tasks = this.queue.list({ projectId: agent.project_id, group: agent.group_name });
		if (tasks.length === 0) return "queue is empty";
		return tasks
			.map((task) => {
				const owner = task.to_agent ? (this.registry.byId(task.to_agent)?.label ?? task.to_agent) : "-";
				const pin = task.pin_slot ? ` pin=${task.pin_slot}` : "";
				return `${task.id}  ${task.status.padEnd(8)} ${task.kind.padEnd(8)} ${owner.padEnd(14)} ${taskTitle(task.body)}${pin}`;
			})
			.join("\n");
	}

	takeInbox(agent: AgentRow, limit = 50): MailRow[] {
		return this.mailer.inbox(agent.seat, limit);
	}

	sendMail(agent: AgentRow, to: AgentRow, kind: MailKind, body: MailBody): string {
		return this.mailer.send({
			fromAgent: agent.id,
			fromSeat: agent.seat,
			toSeat: to.seat,
			toAgent: to.id,
			kind,
			body,
		});
	}
}

function defaultModelForRole(config: TeamsConfig, role: Role): string {
	if (role === "worker") return config.models.routing.default;
	return config.models.role[role];
}

export function describeReport(row: MailRow): { status: string; summary: string; at: number; taskId?: string } {
	let status = "progress";
	let summary = "";
	let taskId: string | undefined;
	try {
		const parsed: unknown = JSON.parse(row.body);
		if (typeof parsed === "object" && parsed !== null) {
			if ("status" in parsed && typeof parsed.status === "string") status = parsed.status;
			if ("summary" in parsed && typeof parsed.summary === "string") summary = parsed.summary;
			if ("task_id" in parsed && typeof parsed.task_id === "string") taskId = parsed.task_id;
		}
	} catch {
		summary = row.body;
	}
	return { status, summary, at: row.created_at, taskId };
}

export type { Role };
