import type { Database } from "bun:sqlite";
import { shortId } from "./identity";

export type TaskStatus = "queued" | "assigned" | "claimed" | "running" | "done" | "failed" | "blocked" | "cancelled";

export const ACTIVE_STATUSES: TaskStatus[] = ["assigned", "claimed", "running"];

export interface TaskRow {
	id: string;
	project_id: string | null;
	group_name: string | null;
	from_agent: string;
	from_seat: string | null;
	to_agent: string | null;
	to_seat: string | null;
	title: string;
	body: string;
	kind: string;
	difficulty: string;
	model: string | null;
	status: TaskStatus;
	sha: string | null;
	attempts: number;
	created_at: number;
	updated_at: number;
	slot_id: string | null;
	claimed_at: number | null;
	source_slot: string | null;
	source_sha: string | null;
	parent_task: string | null;
	escalated_at: number | null;
	pin_slot: string | null;
}

export interface TaskScope {
	projectId: string | null;
	group: string | null;
}

export interface NewTask {
	projectId: string | null;
	group: string | null;
	fromAgent: string;
	fromSeat: string;
	toAgent?: string | null;
	toSeat?: string | null;
	slotId?: string | null;
	body: string;
	kind: string;
	difficulty: string;
	model: string | null;
	status: "queued" | "assigned";
	parentTask?: string | null;
	sourceSlot?: string | null;
	sourceSha?: string | null;
	pinSlot?: string | null;
}

export type FailOutcome = { status: "queued" | "blocked"; attempts: number };

export function taskTitle(body: string): string {
	const firstLine = body.split("\n").find((line) => line.trim().length > 0) ?? body;
	return firstLine.trim().slice(0, 120);
}

export class TaskQueue {
	constructor(
		private readonly db: Database,
		private readonly now: () => number = Date.now,
	) {}

	byId(id: string): TaskRow | null {
		return (this.db.query("SELECT * FROM tasks WHERE id = ?").get(id) as TaskRow | null) ?? null;
	}

	create(input: NewTask): TaskRow {
		const id = `T-${shortId().slice(0, 6)}`;
		const at = this.now();
		this.db.run(
			`INSERT INTO tasks (id, project_id, group_name, from_agent, from_seat, to_agent, to_seat, slot_id, title, body,
				kind, difficulty, model, status, attempts, created_at, updated_at, parent_task, source_slot, source_sha, pin_slot)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.projectId,
				input.group,
				input.fromAgent,
				input.fromSeat,
				input.toAgent ?? null,
				input.toSeat ?? null,
				input.slotId ?? null,
				taskTitle(input.body),
				input.body,
				input.kind,
				input.difficulty,
				input.model,
				input.status,
				at,
				at,
				input.parentTask ?? null,
				input.sourceSlot ?? null,
				input.sourceSha ?? null,
				input.pinSlot ?? null,
			],
		);
		return this.byId(id) as TaskRow;
	}

	claim(scope: TaskScope, owner: { agentId: string; slotId: string; seat: string; merge: boolean }): TaskRow | null {
		const at = this.now();
		const row = this.db
			.query(
				`UPDATE tasks SET status = 'claimed', to_agent = ?, to_seat = ?, slot_id = ?, claimed_at = ?, updated_at = ?
				 WHERE id = (
					SELECT id FROM tasks
					WHERE project_id IS ? AND group_name IS ? AND status = 'queued' AND (kind = 'merge') = ?
					AND (pin_slot IS NULL OR pin_slot = ?)
					ORDER BY CASE WHEN pin_slot IS NULL THEN 1 ELSE 0 END, created_at, rowid LIMIT 1
				 ) AND status = 'queued'
				 RETURNING *`,
			)
			.get(
				owner.agentId,
				owner.seat,
				owner.slotId,
				at,
				at,
				scope.projectId,
				scope.group,
				owner.merge ? 1 : 0,
				owner.slotId,
			) as TaskRow | null;
		return row ?? null;
	}

	markRunning(taskId: string, owner: { agentId: string; slotId: string | null }): void {
		this.db.run(
			`UPDATE tasks SET status = 'running', to_agent = ?, slot_id = COALESCE(?, slot_id),
				updated_at = ? WHERE id = ? AND status IN ('assigned', 'claimed')`,
			[owner.agentId, owner.slotId, this.now(), taskId],
		);
	}

	current(agentId: string, seat: string): TaskRow | null {
		return (
			(this.db
				.query(
					`SELECT * FROM tasks WHERE (to_agent = ? OR to_seat = ?) AND status IN ('assigned', 'claimed', 'running')
					 ORDER BY created_at DESC, rowid DESC LIMIT 1`,
				)
				.get(agentId, seat) as TaskRow | null) ?? null
		);
	}

	heldAll(agentId: string, seat: string): TaskRow[] {
		return this.db
			.query(
				`SELECT * FROM tasks WHERE (to_agent = ? OR to_seat = ?) AND status IN ('assigned', 'claimed', 'running', 'blocked')
				 ORDER BY created_at DESC, rowid DESC`,
			)
			.all(agentId, seat) as TaskRow[];
	}

	held(agentId: string, seat: string): TaskRow | null {
		return this.heldAll(agentId, seat)[0] ?? null;
	}

	resume(taskId: string): void {
		this.db.run("UPDATE tasks SET status = 'running', escalated_at = NULL, updated_at = ? WHERE id = ? AND status = 'blocked'", [
			this.now(),
			taskId,
		]);
	}

	heldByPredecessor(seat: string, agentId: string): TaskRow[] {
		return this.db
			.query(
				`SELECT * FROM tasks WHERE to_seat = ? AND status IN ('assigned', 'claimed', 'running')
				 AND to_agent IS NOT NULL AND to_agent != ? ORDER BY created_at, rowid`,
			)
			.all(seat, agentId) as TaskRow[];
	}

	inherit(taskId: string, agentId: string, attempts: number): void {
		this.db.run("UPDATE tasks SET status = 'assigned', to_agent = ?, attempts = ?, updated_at = ? WHERE id = ?", [
			agentId,
			attempts,
			this.now(),
			taskId,
		]);
	}

	done(taskId: string, sha?: string | null): void {
		this.db.run("UPDATE tasks SET status = 'done', sha = COALESCE(?, sha), updated_at = ? WHERE id = ?", [
			sha ?? null,
			this.now(),
			taskId,
		]);
	}

	block(taskId: string): void {
		this.db.run("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE id = ?", [this.now(), taskId]);
	}

	failTerminal(taskId: string): void {
		this.db.run("UPDATE tasks SET status = 'failed', attempts = attempts + 1, updated_at = ? WHERE id = ?", [
			this.now(),
			taskId,
		]);
	}

	fail(taskId: string, maxFailures: number): FailOutcome {
		const task = this.byId(taskId);
		if (!task) return { status: "blocked", attempts: 0 };
		const attempts = task.attempts + 1;
		if (attempts >= maxFailures) {
			this.db.run("UPDATE tasks SET status = 'blocked', attempts = ?, updated_at = ? WHERE id = ?", [
				attempts,
				this.now(),
				taskId,
			]);
			return { status: "blocked", attempts };
		}
		this.requeue(taskId, attempts);
		return { status: "queued", attempts };
	}

	requeue(taskId: string, attempts?: number): void {
		this.db.run(
			`UPDATE tasks SET status = 'queued', attempts = COALESCE(?, attempts), to_agent = NULL, to_seat = NULL,
				slot_id = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?`,
			[attempts ?? null, this.now(), taskId],
		);
	}

	reassignToSeat(taskId: string, attempts: number): void {
		this.db.run("UPDATE tasks SET status = 'assigned', to_agent = NULL, attempts = ?, updated_at = ? WHERE id = ?", [
			attempts,
			this.now(),
			taskId,
		]);
	}

	issuedBy(seat: string, statuses: TaskStatus[]): TaskRow[] {
		const rows = this.db
			.query("SELECT * FROM tasks WHERE from_seat = ? ORDER BY created_at, rowid")
			.all(seat) as TaskRow[];
		return rows.filter((row) => statuses.includes(row.status));
	}

	cancelOpen(tasks: TaskRow[]): TaskRow[] {
		const stmt = this.db.prepare(
			"UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'assigned', 'claimed', 'running', 'blocked')",
		);
		const at = this.now();
		const cancelled: TaskRow[] = [];
		this.db.transaction((rows: TaskRow[]) => {
			for (const row of rows) if (stmt.run(at, row.id).changes > 0) cancelled.push(row);
		})(tasks);
		return cancelled;
	}

	touch(taskId: string): void {
		this.db.run("UPDATE tasks SET updated_at = ? WHERE id = ?", [this.now(), taskId]);
	}

	markEscalated(taskId: string): void {
		this.db.run("UPDATE tasks SET escalated_at = ? WHERE id = ?", [this.now(), taskId]);
	}

	descendants(rootId: string): TaskRow[] {
		const out: TaskRow[] = [];
		let frontier = [rootId];
		const seen = new Set<string>([rootId]);
		while (frontier.length > 0) {
			const placeholders = frontier.map(() => "?").join(", ");
			const children = this.db
				.query(`SELECT * FROM tasks WHERE parent_task IN (${placeholders}) ORDER BY created_at, rowid`)
				.all(...frontier) as TaskRow[];
			frontier = [];
			for (const child of children) {
				if (seen.has(child.id)) continue;
				seen.add(child.id);
				out.push(child);
				frontier.push(child.id);
			}
		}
		return out;
	}

	list(scope: TaskScope, statuses?: TaskStatus[]): TaskRow[] {
		const rows = this.db
			.query("SELECT * FROM tasks WHERE project_id IS ? AND group_name IS ? ORDER BY created_at, rowid")
			.all(scope.projectId, scope.group) as TaskRow[];
		return statuses ? rows.filter((row) => statuses.includes(row.status)) : rows;
	}
}
