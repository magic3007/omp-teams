import type { TaskDifficulty, TaskKind } from "./config";
import { groupSeat, labelFor, projectSeat, workerSeat } from "./identity";
import { isManagerRole } from "./policy";
import { taskPaths, type TaskRow } from "./queue";
import type { AgentRow } from "./registry";
import { findRepository } from "./repos";
import { NO_OPEN_TASK, type TeamsRuntime } from "./runtime";
import { spawnAnalyst, spawnGroup, spawnProject, spawnWorker, relaunchSeat, type SpawnDeps } from "./spawn";

export interface RouteDeps {
	runtime: TeamsRuntime;
	spawn: SpawnDeps | null;
	awaitMember: (seat: string) => Promise<AgentRow | null>;
}

export interface WorkRequest {
	to: string;
	task: string;
	kind: TaskKind;
	difficulty: TaskDifficulty;
	paths?: string[];
	model?: string;
	requireOpenTask?: boolean;
}

export interface ForwardRequest {
	group?: string;
	taskId?: string;
}

type RouteFailure = { ok: false; error: string; askHuman?: true };

export type Routed = { ok: true; taskId: string; to: AgentRow | null; started: string | null; model: string | null } | RouteFailure;

interface Delivery {
	task: string;
	kind: TaskKind;
	difficulty: TaskDifficulty;
	paths?: string[];
	model?: string;
	parentTask?: string;
	requireOpenTask?: boolean;
}

type Ensured = { ok: true; agent: AgentRow; started: string | null } | RouteFailure;

export async function awaitSeat(runtime: TeamsRuntime, seat: string, timeoutMs = 150_000): Promise<AgentRow | null> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const row = runtime.registry.bySeat(seat);
		if (row) return row;
		await Bun.sleep(500);
	}
	return null;
}

export function routeDeps(runtime: TeamsRuntime, spawn: SpawnDeps | null): RouteDeps {
	return { runtime, spawn, awaitMember: (seat) => awaitSeat(runtime, seat) };
}

function subordinate(actor: AgentRow, ref: string, runtime: TeamsRuntime): AgentRow | null {
	const wanted = ref.trim();
	if (!wanted) return null;
	return (
		runtime.registry.childrenOf(actor.seat).find((row) => row.id === wanted || row.seat === wanted || row.label === wanted) ??
		null
	);
}

function deliver(deps: RouteDeps, actor: AgentRow, target: AgentRow | null, delivery: Delivery, started: string | null): Routed {
	const assigned = deps.runtime.assign(actor, {
		to: target?.id,
		task: delivery.task,
		kind: delivery.kind,
		difficulty: delivery.difficulty,
		paths: delivery.paths,
		model: delivery.model,
		requireOpenTask: delivery.requireOpenTask ?? true,
		parentTask: delivery.parentTask,
	});
	if (!assigned.ok) return assigned;
	return { ok: true, taskId: assigned.taskId, to: target, started, model: assigned.model };
}

async function wakeParked(deps: RouteDeps, holder: AgentRow): Promise<AgentRow | null> {
	deps.runtime.wakeSeat(holder.seat);
	const panes = deps.spawn?.herdr.listPanes();
	if (deps.spawn && !(panes?.ok && panes.value.some((pane) => pane.pane_id === holder.pane_id))) {
		const relaunched = relaunchSeat(deps.spawn, holder);
		if (!relaunched.ok) return null;
	}
	return deps.awaitMember(holder.seat);
}

async function ensureRepoLeader(deps: RouteDeps, actor: AgentRow, name: string): Promise<Ensured> {
	const config = deps.runtime.configOf(actor);
	const found = findRepository(name, {
		registered: deps.runtime.registry.allProjects(),
		roots: config.repos.roots,
		depth: config.repos.depth,
	});
	if (!found.ok) return { ...found, askHuman: true };
	const seat = projectSeat(found.project.id);
	const live = deps.runtime.registry.bySeat(seat);
	if (live) return { ok: true, agent: live, started: null };
	const parked = deps.runtime.registry.holder(seat);
	if (parked) {
		const woken = await wakeParked(deps, parked);
		if (woken) return { ok: true, agent: woken, started: null };
		return { ok: false, error: `${parked.label} is parked and did not come back.` };
	}
	if (!deps.spawn) return { ok: false, error: `${found.project.name} has no repo leader and starting one needs a herdr pane.` };
	const spawned = spawnProject(deps.spawn, actor, { repoPath: found.project.root });
	if (!spawned.ok) return spawned;
	const agent = await deps.awaitMember(seat);
	if (!agent) return { ok: false, error: `the repo leader of ${found.project.name} did not register in time.` };
	return { ok: true, agent, started: agent.label };
}

async function ensureGroupLeader(deps: RouteDeps, actor: AgentRow, name: string): Promise<Ensured> {
	if (!actor.project_id) return { ok: false, error: `${actor.label} is not bound to a repository.` };
	const seat = groupSeat(actor.project_id, name);
	const live = deps.runtime.registry.bySeat(seat);
	if (live) return { ok: true, agent: live, started: null };
	const parked = deps.runtime.registry.holder(seat);
	if (parked) {
		const woken = await wakeParked(deps, parked);
		if (woken) return { ok: true, agent: woken, started: null };
		return { ok: false, error: `${parked.label} is parked and did not come back.` };
	}
	if (!deps.spawn) return { ok: false, error: `group ${name} has no leader and starting one needs a herdr pane.` };
	const spawned = spawnGroup(deps.spawn, actor, { name });
	if (!spawned.ok) return spawned;
	const agent = await deps.awaitMember(seat);
	if (!agent) return { ok: false, error: `the leader of group ${name} did not register in time.` };
	return { ok: true, agent, started: agent.label };
}

async function startAnalyst(deps: RouteDeps, actor: AgentRow, taskId: string): Promise<Ensured> {
	if (!deps.spawn) return { ok: false, error: "starting an analyst needs a herdr pane." };
	const spawned = spawnAnalyst(deps.spawn, actor, taskId);
	if (!spawned.ok) return spawned;
	const agent = await deps.awaitMember(workerSeat(spawned.value.slotId));
	if (!agent) return { ok: false, error: `the analyst for ${taskId} did not register in time.` };
	return { ok: true, agent, started: agent.label };
}

function ensureWorker(deps: RouteDeps, actor: AgentRow): { ok: true; started: string | null } | { ok: false; error: string } {
	if (!actor.project_id || !actor.group_name) return { ok: false, error: `${actor.label} is not bound to a group.` };
	const existing = deps.runtime.slots
		.forGroup(actor.project_id, actor.group_name, "worker")
		.filter((slot) => slot.status !== "retired" && slot.status !== "retiring");
	if (existing.length > 0) return { ok: true, started: null };
	if (!deps.spawn) return { ok: false, error: `group ${actor.group_name} has no worker and starting one needs a herdr pane.` };
	const spawned = spawnWorker(deps.spawn, actor, { count: 1 });
	if (!spawned.ok) return spawned;
	const first = spawned.value[0];
	return { ok: true, started: first ? labelFor("worker", { group: actor.group_name, index: first.index }) : null };
}

export async function assignWork(deps: RouteDeps, actor: AgentRow, request: WorkRequest): Promise<Routed> {
	if (!isManagerRole(actor.role)) return { ok: false, error: `${actor.label} is a ${actor.role}; only leaders route work.` };
	const to = request.to.trim();
	if (!to) return { ok: false, error: "name the repository, the group or the worker this work goes to." };
	if (actor.role !== "personal" && (request.requireOpenTask ?? true) && !deps.runtime.heldTask(actor)) {
		return { ok: false, error: NO_OPEN_TASK };
	}
	const delivery: Delivery = {
		task: request.task,
		kind: request.kind,
		difficulty: request.difficulty,
		paths: request.paths,
		model: request.model,
		requireOpenTask: request.requireOpenTask,
	};

	const direct = subordinate(actor, to, deps.runtime);
	if (direct) {
		if (direct.status !== "parked") return deliver(deps, actor, direct, delivery, null);
		const woken = await wakeParked(deps, direct);
		if (!woken) return { ok: false, error: `${direct.label} is parked and did not come back.` };
		return deliver(deps, actor, woken, delivery, null);
	}
	if (actor.role === "personal") {
		const ensured = await ensureRepoLeader(deps, actor, to);
		if (!ensured.ok) return ensured;
		return deliver(deps, actor, ensured.agent, delivery, ensured.started);
	}
	if (actor.role === "project") {
		const ensured = await ensureGroupLeader(deps, actor, to);
		if (!ensured.ok) return ensured;
		return deliver(deps, actor, ensured.agent, delivery, ensured.started);
	}
	const options = deps.runtime.registry.childrenOf(actor.seat).map((row) => row.label);
	return {
		ok: false,
		error: `cannot resolve "${to}". A group leader queues work with teams_forward. Workers here: ${options.join(", ") || "none"}`,
	};
}

export function queueWork(deps: RouteDeps, actor: AgentRow, request: Omit<WorkRequest, "to">): Routed {
	if (actor.role !== "group") return { ok: false, error: `${actor.label} is a ${actor.role}; only a group leader queues work.` };
	const ensured = ensureWorker(deps, actor);
	if (!ensured.ok) return ensured;
	return deliver(deps, actor, null, request, ensured.started);
}

function pickHeld(actor: AgentRow, held: TaskRow[], wanted?: string): TaskRow | string {
	if (wanted) {
		const found = held.find((task) => task.id === wanted);
		return found ?? `you cannot forward ${wanted}: it is not a held task without a forwarded child.`;
	}
	if (held.length === 1 && held[0]) return held[0];
	return `you hold ${held.length} tasks that are not forwarded yet: ${held.map((task) => task.id).join(", ")}. Pass task_id with the one this work serves.`;
}

export async function forwardTask(deps: RouteDeps, actor: AgentRow, request: ForwardRequest): Promise<Routed> {
	if (actor.role !== "project" && actor.role !== "group") {
		return { ok: false, error: `${actor.label} is a ${actor.role}; only repo and group leaders forward a task they hold.` };
	}
	const open = deps.runtime.forwardable(actor);
	if (open.length === 0) {
		const total = deps.runtime.queue.heldAll(actor.id, actor.seat);
		return {
			ok: false,
			error:
				total.length === 0
					? NO_OPEN_TASK
					: `every task you hold is already forwarded (${total.map((task) => task.id).join(", ")}). Wait for its report.`,
		};
	}
	const picked = pickHeld(actor, open, request.taskId?.trim());
	if (typeof picked === "string") return { ok: false, error: picked };
	const delivery: Delivery = {
		task: picked.body,
		kind: picked.kind as TaskKind,
		difficulty: picked.difficulty as TaskDifficulty,
		paths: taskPaths(picked),
		model: picked.model ?? undefined,
		parentTask: picked.id,
	};
	if (actor.role === "group") {
		const ensured = ensureWorker(deps, actor);
		if (!ensured.ok) return ensured;
		return deliver(deps, actor, null, delivery, ensured.started);
	}
	if (picked.kind === "analysis") {
		const analyst = await startAnalyst(deps, actor, picked.id);
		if (!analyst.ok) return analyst;
		return deliver(deps, actor, analyst.agent, delivery, analyst.started);
	}
	const group = request.group?.trim();
	if (!group) return { ok: false, error: "name the group this task goes to." };
	const ensured = await ensureGroupLeader(deps, actor, group);
	if (!ensured.ok) return ensured;
	return deliver(deps, actor, ensured.agent, delivery, ensured.started);
}
