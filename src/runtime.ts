/**
 * Team operations that do not depend on the omp UI layer.
 *
 * Everything here is driven by the SQLite registry, mailbox and task queue, so
 * it can be unit-tested without a model, a pane manager or the extension
 * runtime. The extension calls these from tools, commands and its poll loop.
 */
import type { Database } from "bun:sqlite";
import { configStamp, loadConfig, resolveModel, type TaskDifficulty, type TaskKind, type TeamsConfig } from "./config";
import { logEvent, teamsHome } from "./db";
import { formatUsd, guardState, readState, recordSpend, setState, spendToday } from "./guard";
import { type Role, sessionTag } from "./identity";
import { type MailBody, type MailKind, Mailer, type MailRow } from "./mail";
import { mergeIntoGroup } from "./merge";
import { isManagerRole } from "./policy";
import { ACTIVE_STATUSES, TaskQueue, type TaskRow, taskTitle } from "./queue";
import { type AgentRow, type GroupRow, type RegisterInput, type RegisterResult, Registry } from "./registry";
import { type SlotKind, type SlotRow, Slots } from "./slots";
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
	/** Direct subordinate. A group lead may omit it to put the task on the group queue. */
	to?: string;
	task: string;
	kind: TaskKind;
	difficulty: TaskDifficulty;
	paths?: string[];
	model?: string;
	/**
	 * Refuse unless the manager holds an open task from its own manager. Set for
	 * model-driven assignment by project and group leads, so their work always
	 * traces back to a request and stops once that request is closed.
	 */
	requireOpenTask?: boolean;
	/** The held task this work serves. Required with `requireOpenTask` when the manager holds more than one. */
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
	/** Short omp session id, unique among live members; `omp -r <session>` resumes it. */
	session: string;
	/** The task the subordinate holds right now, if any. */
	current: TaskRow | null;
	lastReport: { status: string; summary: string; at: number; taskId?: string } | null;
}

export type MergeOutcome = { ok: true; summary: string } | { ok: false; error: string };

export interface PatrolResult {
	inherited: string[];
	requeued: string[];
	blocked: string[];
	escalated: string[];
	stalled: string[];
	unpinned: string[];
	/** Brakes that tripped in this tick (budget, per-group blocked rate). */
	guards: string[];
	/** The manager closed the task it had received because all its own work finished. */
	drained: boolean;
}

/** Refusal shown to a lead that tries to start work nobody asked for. */
export const NO_OPEN_TASK =
	"you have no open task from your manager, so there is nothing to delegate. Report what you have with teams_report and wait for the next task.";

/**
 * How long a task's work must stay finished before the task closes by itself.
 * A lead with a sequential plan queues the next step after the previous merge
 * report wakes it; closing sooner would cut the plan short.
 */
export const CLOSE_GRACE_MS = 120_000;

/** The slot id behind a worker seat (`worker:<slot>`), or null for managers. */
export function slotOfSeat(seat: string): string | null {
	return seat.startsWith("worker:") ? seat.slice("worker:".length) : null;
}

export class TeamsRuntime {
	readonly registry: Registry;
	readonly mailer: Mailer;
	readonly slots: Slots;
	readonly queue: TaskQueue;
	private readonly configs = new Map<string, { config: TeamsConfig; stamp: string }>();

	/** Directory that holds the database, worktrees, reports and exports. */
	readonly home: string;
	/** The shared registry database. */
	readonly db: Database;

	constructor(private readonly options: RuntimeOptions) {
		this.home = options.home ?? teamsHome();
		this.db = options.db;
		const now = options.now ?? Date.now;
		this.registry = new Registry(options.db, {
			deadAfterMs: options.deadAfterMs ?? loadConfig(undefined, options.home).limits.dead_after_seconds * 1000,
			now,
		});
		this.mailer = new Mailer(options.db, now);
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
		// Re-read when a configuration file changed: a budget or window edit must apply to a running team.
		if (cached && cached.stamp === stamp) return cached.config;
		const config = loadConfig(projectRoot, this.options.home);
		this.configs.set(key, { config, stamp });
		return config;
	}

	/** Drop cached configuration, after a config file changed. */
	invalidateConfig(): void {
		this.configs.clear();
	}

	/** Configuration for a member's project. */
	configOf(agent: AgentRow): TeamsConfig {
		return this.configFor(this.registry.projectRoot(agent.project_id ?? "") ?? undefined);
	}

	/** Current brake state, from the shared database and `agent`'s configuration. */
	guard(agent: AgentRow | null): import("./guard").GuardState {
		const config = agent ? this.configOf(agent) : this.configFor(undefined);
		return guardState(this.options.db, config, this.now());
	}

	/** Today's team spend, in USD. */
	spendToday(): number {
		return spendToday(this.options.db, this.now());
	}

	/**
	 * Record a member's session spend. A session reports its own cost; when the
	 * provider gives no prices, the reported tokens are priced with the
	 * configured table so the budget keeps working.
	 */
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

	/**
	 * Stop the whole team: no new work starts anywhere until `/teams resume`.
	 * Groups paused by a brake are marked with its reason; a human pause stays.
	 */
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

	/**
	 * Lift the halt and any brake pause. A human pause (`paused_reason` null) stays
	 * as it was; a spent budget keeps the team frozen until the limit or the day changes.
	 */
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

	/**
	 * Ask each direct subordinate for a fresh status. The subordinate's extension
	 * runs one ephemeral turn and reports back; the request is rate-limited so a
	 * manager cannot keep interrupting its workers.
	 */
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
		return { ok: true, asked: children.map((row) => row.label) };
	}

	/** Why this member may not start new work right now, or null. */
	stopReason(agent: AgentRow): string | null {
		return this.guard(agent).stopReason;
	}

	/** Tell every live member something, as a wake notice. */
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

	/**
	 * Slot for a worker joining from `input.cwd`.
	 *
	 * An explicit slot id wins; otherwise the slot already bound to this worktree is
	 * reused, and a new one is created for the next free index in the group.
	 */
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

	/** The slot this worker sits in. */
	slotOf(agent: AgentRow): SlotRow | null {
		const slotId = slotOfSeat(agent.seat);
		return slotId ? this.slots.byId(slotId) : null;
	}

	/** Worktree this member works in: its slot's worktree for a worker, else its cwd. */
	worktreeFor(agent: AgentRow): string {
		return this.slotOf(agent)?.worktree ?? agent.cwd;
	}

	groupOf(agent: AgentRow): GroupRow | null {
		if (!agent.project_id || !agent.group_name) return null;
		return this.registry.group(agent.project_id, agent.group_name);
	}

	/** Assign one task: to a direct subordinate, or onto the group queue. Cross-level assignment is refused. */
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

		// The task this work serves. A blocked task is still the manager's: an answer to its blocker lets it delegate again.
		const held = viewer.role === "personal" ? [] : this.queue.heldAll(viewer.id, viewer.seat);
		const list = held.map((task) => `${task.id} (${task.title.slice(0, 60)})`).join(", ");
		let received: TaskRow | null = null;
		// The personal leader has no manager, so it holds nothing to name.
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

		// Only workers execute, so only their tasks are routed to a model; a lead keeps the leader model.
		let model: string | null = null;
		if (!target || target.role === "worker") {
			const resolved = resolveModel(this.configOf(viewer), {
				kind: request.kind,
				difficulty: request.difficulty,
				model: request.model,
				paths: request.paths,
			});
			if ("error" in resolved) return { ok: false, error: resolved.error };
			model = resolved.model;
		}
		if (received?.status === "blocked") this.queue.resume(received.id);
		// Delegating is activity on the parent: it must not look stalled to the manager above.
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
				text: task.body,
			},
		});
	}

	/**
	 * Claim the next queued task for an idle worker and put it in its mailbox.
	 * Returns null when the group is paused, the slot is not available, or the
	 * queue is empty.
	 */
	claimNext(worker: AgentRow): TaskRow | null {
		if (worker.role !== "worker") return null;
		const slot = this.slotOf(worker);
		// A brake stops new work; the integrator still merges what is already finished.
		if (slot?.kind !== "integrator" && this.stopReason(worker)) return null;
		if (!slot || slot.manual === 1 || slot.status !== "occupied") return null;
		const group = this.groupOf(worker);
		if (!group || group.paused === 1) return null;
		if (this.queue.current(worker.id, worker.seat)) return null;

		const task = this.queue.claim(
			{ projectId: worker.project_id, group: worker.group_name },
			{ agentId: worker.id, slotId: slot.id, seat: worker.seat, merge: slot.kind === "integrator" },
		);
		if (!task) return null;
		this.sendTaskMail(task, task.from_agent, task.from_seat ?? worker.parent_seat ?? worker.seat, worker.seat, worker.id);
		logEvent(this.options.db, "claim", { taskId: task.id, slot: slot.id }, worker.id, this.now());
		return task;
	}

	/** Task mail reached the member's transcript: the task is now running. */
	taskDelivered(taskId: string, worker: AgentRow): void {
		this.queue.markRunning(taskId, { agentId: worker.id, slotId: slotOfSeat(worker.seat) });
	}

	/**
	 * A new holder of a seat picks up the tasks its predecessor owned, so a crash or
	 * a rotation never strands work. Each inherited task is mailed again.
	 */
	inheritOpenTasks(agent: AgentRow): TaskRow[] {
		const inherited = this.queue.heldByPredecessor(agent.seat, agent.id);
		for (const task of inherited) {
			this.queue.inherit(task.id, agent.id, task.attempts);
			const fresh = this.queue.byId(task.id);
			if (fresh) this.sendTaskMail(fresh, fresh.from_agent, fresh.from_seat ?? agent.parent_seat ?? agent.seat, agent.seat, agent.id);
			logEvent(this.options.db, "inherit", { taskId: task.id }, agent.id, this.now());
		}
		return inherited;
	}

	report(viewer: AgentRow, request: ReportRequest): ReportResult {
		if (!viewer.parent_seat) {
			return { ok: false, error: `${viewer.label} has no manager to report to.` };
		}
		const parent = this.registry.bySeat(viewer.parent_seat);
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
			// Every worktree shares one object store; a worker's SHA must be in its own history.
			if (this.slotOf(viewer)?.kind === "worker" && !isAncestor(dir, request.sha, "HEAD")) {
				return { ok: false, error: `sha ${request.sha} is not on your branch in ${dir}; report the SHA of your own commit (git rev-parse HEAD).` };
			}
		}

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
			// A task that is already closed (for example by the automatic close) only passes the report on.
			if (task.status !== "done") followUp = this.applyReport(viewer, task, request);
			// A leader's done report carries what the system itself sees: no one needs to commission a check.
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
	}

	/** Move the task through its state machine; returns a note for the manager when something follows. */
	private applyReport(viewer: AgentRow, task: TaskRow, request: ReportRequest): string | undefined {
		const config = this.configOf(viewer);
		switch (request.status) {
			case "progress":
				// A progress report proves the owner is alive; it resets the stall clock and continues a blocked task.
				this.queue.touch(task.id);
				this.queue.resume(task.id);
				return undefined;
			case "blocked":
				this.queue.block(task.id);
				return undefined;
			case "failed": {
				const outcome = this.queue.fail(task.id, config.max_task_failures);
				return outcome.status === "queued"
					? `task ${task.id} returned to the queue (attempt ${outcome.attempts} of ${config.max_task_failures}).`
					: `task ${task.id} is blocked after ${outcome.attempts} failed attempts; it needs a decision.`;
			}
			case "done": {
				this.queue.done(task.id, request.sha ?? null);
				const cancelled = this.cancelOpenDescendants(task, viewer);
				const slot = this.slotOf(viewer);
				if (slot) this.slots.incrementDone(slot.id);
				const note = cancelled > 0 ? `${cancelled} open task(s) under ${task.id} were cancelled.` : undefined;
				// Only a worker's own commit is merged; a manager's done (group branch head) is a deliverable, not a merge.
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

	/**
	 * "Done" means done: once a task is closed, the work still open under it is
	 * moot. Cancel it and tell whoever holds it, so no lead keeps polishing a
	 * request its manager already accepted.
	 */
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

	/** Queue a merge of a finished worker commit when the group has an integrator. */
	private enqueueMerge(worker: AgentRow, task: TaskRow, sha: string): TaskRow | null {
		if (!task.project_id || !task.group_name) return null;
		const integrator = this.slots.integratorFor(task.project_id, task.group_name);
		if (!integrator) return null;
		// A commit the group branch already contains (a verification task reporting the head) needs no merge.
		const group = this.registry.group(task.project_id, task.group_name);
		if (group && isAncestor(group.worktree, sha, "HEAD")) return null;
		const groupSeat = worker.parent_seat;
		if (!groupSeat) return null;
		const lead = this.registry.bySeat(groupSeat);
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

	/**
	 * Run one merge task (integrator only). The git work is deterministic; a
	 * conflict or failed verification goes back to the worker that wrote the
	 * commit as a pinned follow-up task.
	 */
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

		const config = this.configOf(integrator);
		const sourceSlot = task.source_slot ? this.slots.byId(task.source_slot) : null;
		const sourceLabel = sourceSlot ? `worker ${sourceSlot.index_no} · ${sourceSlot.group_name ?? ""}` : "a worker";

		// The group branch only moves through this tool. Any other head means it was rewritten.
		const actualHead = branchHead(group.worktree);
		if (group.head_sha && actualHead && actualHead !== group.head_sha) {
			this.queue.block(task.id);
			const summary = `${group.branch} moved outside the integrator (expected ${group.head_sha.slice(0, 12)}, found ${actualHead.slice(0, 12)}). Merges are on hold until a human checks the branch and runs /teams accept-head ${group.name}.`;
			this.report(integrator, { status: "blocked", summary });
			logEvent(this.options.db, "merge:head-mismatch", { expected: group.head_sha, actual: actualHead }, integrator.id, this.now());
			return { ok: true, summary };
		}

		const result = mergeIntoGroup(
			group.worktree,
			task.source_sha,
			`teams: merge ${task.parent_task ?? task.id} from ${sourceLabel}`,
			{ verifyCommand: config.merge.verify_command, verifyTimeoutMs: config.merge.verify_timeout_seconds * 1000 },
		);

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
				summary = `${task.source_sha.slice(0, 12)} from ${sourceLabel} is in ${group.branch} at ${result.sha.slice(0, 12)}${
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
						`Rework your commit ${task.source_sha.slice(0, 12)} (task ${task.parent_task ?? "-"}) so it merges cleanly.`,
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
				summary = `${result.kind === "conflict" ? "conflict" : "verification failure"} merging ${task.source_sha.slice(0, 12)} from ${sourceLabel}; sent back as ${followUp.id}.`;
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

	/** Direct subordinates with their most recent report. Reads the registry only. */
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

	/** Session ids of every live member: the pool that keeps short session tags unique. */
	sessionPool(): string[] {
		return this.registry.allAlive().map((row) => row.session_id);
	}

	/** Pause or resume work hand-out for a group. The group lead or any manager above it may do this. */
	pause(viewer: AgentRow, groupName: string, paused: boolean): { ok: true } | { ok: false; error: string } {
		const allowed =
			(viewer.role === "personal" && viewer.project_id === null) ||
			(viewer.role === "project" && viewer.project_id !== null) ||
			(viewer.role === "group" && viewer.group_name === groupName);
		if (!allowed) return { ok: false, error: `${viewer.label} cannot pause group ${groupName}.` };
		// The personal leader spans every repository, so its group name must be unambiguous.
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

	/** Ask a worker to leave after its current task. Only its group lead may do this. */
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

	/** A human drives the worker pane: stop claiming and stop injecting mail, or give control back. */
	setManual(worker: AgentRow, manual: boolean): { ok: true } | { ok: false; error: string } {
		const slot = this.slotOf(worker);
		if (!slot) return { ok: false, error: "takeover applies to workers only." };
		this.slots.setManual(slot.id, manual);
		logEvent(this.options.db, manual ? "takeover" : "release", { slot: slot.id }, worker.id, this.now());
		return { ok: true };
	}

	/**
	 * Patrol what this manager issued: re-home tasks of dead owners, requeue or
	 * block failures, escalate blocked and stalled work, release pins on retired
	 * slots, and close the manager's own task once all its work is done.
	 */
	patrol(manager: AgentRow): PatrolResult {
		const result: PatrolResult = {
			inherited: [],
			requeued: [],
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
				if (owner?.status !== "alive") {
					const holder = task.to_seat ? this.registry.bySeat(task.to_seat) : null;
					if (holder && holder.id !== task.to_agent) {
						this.queue.inherit(task.id, holder.id, task.attempts + 1);
						const fresh = this.queue.byId(task.id);
						if (fresh) this.sendTaskMail(fresh, manager.id, manager.seat, holder.seat, holder.id);
						result.inherited.push(task.id);
					} else if (task.status === "assigned" && task.to_seat) {
						// Directly addressed to a seat nobody holds right now: wait for the next holder.
						this.queue.reassignToSeat(task.id, task.attempts);
					} else {
						const outcome = this.queue.fail(task.id, config.max_task_failures);
						(outcome.status === "queued" ? result.requeued : result.blocked).push(task.id);
					}
					continue;
				}
				if (task.status === "running" && !task.escalated_at && now - task.updated_at > config.stall_minutes * 60_000) {
					this.mailer.send({
						fromAgent: manager.id,
						fromSeat: manager.seat,
						toSeat: manager.seat,
						toAgent: manager.id,
						kind: "notice",
						taskId: task.id,
						body: {
							text: `Task ${task.id} (${task.title}) has run for ${Math.round((now - task.updated_at) / 60_000)} minutes without a report from ${owner.label}. Ask with teams_ask, or decide whether to re-scope it.`,
						},
					});
					this.queue.markEscalated(task.id);
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
			this.queue.markEscalated(task.id);
			if (!manager.parent_seat) continue;
			const reported = this.report(manager, {
				status: "blocked",
				summary: `${task.id} (${task.title}) is blocked after ${task.attempts} attempt(s) and needs a decision.`,
			});
			if (reported.ok) result.escalated.push(task.id);
		}

		if (manager.role === "group" && manager.project_id && manager.group_name) {
			if (this.blockedRateGuard(manager, config)) result.guards.push(`blocked-rate:${manager.group_name}`);
		}

		result.drained = this.closeIfDrained(manager);
		if (result.inherited.length + result.requeued.length + result.blocked.length + result.escalated.length + result.guards.length > 0) {
			logEvent(this.options.db, "patrol", result, manager.id, now);
		}
		return result;
	}

	/**
	 * Budget brake: once today's spend reaches the limit, every group is paused
	 * with reason `budget` (assign and spawn refuse anyway); a new day or a higher
	 * limit lifts it. Runs on every manager's patrol, so whichever member ticks
	 * first applies it for everyone.
	 */
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
		// Spend dropped under the limit (new day, higher limit): release brake pauses.
		for (const group of this.registry.allGroups()) {
			if (group.paused === 1 && group.paused_reason === "budget") {
				this.registry.setGroupPaused(group.project_id, group.name, false);
				logEvent(this.options.db, "guard:budget-lifted", { group: group.name }, manager.id, this.now());
			}
		}
	}

	/**
	 * A group that produces `guards.group_blocked_per_hour` blockers within an
	 * hour is paused and escalated: a group that keeps getting stuck needs a
	 * human, not more of the same work.
	 */
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
		this.registry.setGroupPaused(manager.project_id, manager.group_name, true, "blocked-rate");
		const summary = `group ${manager.group_name} produced ${count} blocked report(s) in the last hour (limit ${limit}); it is paused and needs a human. Resume it with /teams resume ${manager.group_name} once the cause is fixed.`;
		this.report(manager, { status: "blocked", summary });
		logEvent(this.options.db, "guard:blocked-rate", { group: manager.group_name, count, limit }, manager.id, this.now());
		return true;
	}

	/**
	 * Close every task the manager holds whose work is all done: the children
	 * created for it, their merges and reworks. Like any leader's done report,
	 * the closing report carries the delivered branches, their heads and the
	 * files they change against their base (see {@link report}).
	 */
	private closeIfDrained(manager: AgentRow): boolean {
		if (!manager.parent_seat) return false;
		let closed = false;
		// Oldest first, so reports arrive in the order the tasks were given.
		const active = this.queue
			.heldAll(manager.id, manager.seat)
			.filter((task) => ACTIVE_STATUSES.includes(task.status))
			.reverse();
		for (const received of active) {
			// A merge that conflicted is closed as failed; its rework task carries the work on.
			const work = this.queue.descendants(received.id).filter((task) => task.status !== "failed" && task.status !== "cancelled");
			if (work.length === 0 || work.some((task) => task.status !== "done")) continue;
			// Give the manager time to queue the next step of a sequential plan before its task closes.
			if (this.now() - Math.max(...work.map((task) => task.updated_at)) < CLOSE_GRACE_MS) continue;
			const head = manager.role === "group" ? branchHead(this.groupOf(manager)?.worktree ?? this.worktreeFor(manager)) : null;
			const reported = this.report(manager, {
				taskId: received.id,
				status: "done",
				sha: head ?? undefined,
				summary: `all ${work.length} task(s) created for ${received.id} are done.`,
			});
			if (reported.ok) closed = true;
		}
		return closed;
	}

	/** Group branches a closed task delivered: a group leader's own, or the groups a repo leader's children went to. */
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

	/** One group branch as evidence: its head and the files it changes against its base. */
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
		// The full SHA: a manager above should not need to ask for it.
		return `- ${group.branch} at ${head ?? "?"}; changes against ${base}: ${listed}`;
	}

	/** A human accepts the group branch as it is now (after a rewrite was detected). */
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

	/** Cheap counters for the status line: members in scope, task states, unread mail. */
	counts(agent: AgentRow): {
		projects: number;
		groups: number;
		workers: number;
		queued: number;
		running: number;
		done: number;
		blocked: number;
		unread: number;
	} {
		const alive = this.registry.allAlive();
		const inScope = (row: AgentRow): boolean => {
			if (agent.role === "personal") return true;
			if (!agent.project_id) return false;
			if (row.project_id !== agent.project_id) return false;
			if (agent.role === "project") return true;
			return row.group_name === agent.group_name;
		};
		const scoped = alive.filter(inScope);
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
		// The integrator sits in a worker seat but does not take work; it is not counted as a worker.
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
		};
	}

	/** The task this member is working on, if any. */
	currentTask(agent: AgentRow): TaskRow | null {
		return this.queue.current(agent.id, agent.seat);
	}

	/** The task this member holds, including one it reported blocked and may continue. */
	heldTask(agent: AgentRow): TaskRow | null {
		return this.queue.held(agent.id, agent.seat);
	}

	/** Text form of a group's queue, for `/teams queue`. */
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

	/** Undelivered mail for `agent`, oldest first. */
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

/** Role default model: workers route through the task routing default. */
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
