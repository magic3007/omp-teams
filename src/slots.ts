/**
 * Worker slots.
 *
 * A slot is a durable seat: one worktree, one branch, one herdr pane slot. The
 * session living in it can be replaced (crash, rotation) while the seat keeps
 * its identity, so mail and tasks addressed to the slot survive.
 */
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";

export type SlotKind = "worker" | "integrator";
export type SlotStatus = "free" | "occupied" | "retiring" | "retired";

export interface SlotRow {
	id: string;
	project_id: string | null;
	group_name: string | null;
	kind: SlotKind;
	index_no: number;
	worktree: string;
	branch: string;
	tab_id: string | null;
	pane_id: string | null;
	agent_id: string | null;
	session_id: string | null;
	status: SlotStatus;
	created_at: number;
	/** A human is driving the pane: no claims, no mail injection. */
	manual: number;
	/** Tasks completed by the current session, for rotation. */
	tasks_done: number;
}

export function slotIdFor(projectId: string | null, group: string, index: number, kind: SlotKind): string {
	const digest = createHash("sha256").update(`${projectId ?? "-"}/${group}/${kind}/${index}`).digest("hex");
	return `s-${digest.slice(0, 8)}`;
}

export class Slots {
	constructor(
		private readonly db: Database,
		private readonly now: () => number = Date.now,
	) {}

	/** Every slot, for rebuilds and reports. */
	all(): SlotRow[] {
		return this.db.query("SELECT * FROM slots ORDER BY project_id, group_name, kind, index_no").all() as SlotRow[];
	}

	byId(id: string): SlotRow | null {
		return (this.db.query("SELECT * FROM slots WHERE id = ?").get(id) as SlotRow | null) ?? null;
	}

	forGroup(projectId: string | null, group: string, kind: SlotKind = "worker"): SlotRow[] {
		return this.db
			.query(
				"SELECT * FROM slots WHERE project_id IS ? AND group_name = ? AND kind = ? ORDER BY index_no",
			)
			.all(projectId, group, kind) as SlotRow[];
	}

	/** Create or return the slot for this (group, kind, index). */
	ensure(input: {
		projectId: string | null;
		group: string;
		kind: SlotKind;
		index: number;
		worktree: string;
		branch: string;
	}): SlotRow {
		const id = slotIdFor(input.projectId, input.group, input.index, input.kind);
		const existing = this.byId(id);
		if (existing) {
			this.db.run("UPDATE slots SET worktree = ?, branch = ? WHERE id = ?", [input.worktree, input.branch, id]);
			return this.byId(id) as SlotRow;
		}
		this.db.run(
			`INSERT INTO slots (id, project_id, group_name, kind, index_no, worktree, branch, status, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, 'free', ?)`,
			[id, input.projectId, input.group, input.kind, input.index, input.worktree, input.branch, this.now()],
		);
		return this.byId(id) as SlotRow;
	}

	bind(slotId: string, input: { paneId?: string | null; tabId?: string | null }): void {
		if (input.paneId !== undefined) this.db.run("UPDATE slots SET pane_id = ? WHERE id = ?", [input.paneId, slotId]);
		if (input.tabId !== undefined) this.db.run("UPDATE slots SET tab_id = ? WHERE id = ?", [input.tabId, slotId]);
	}

	/** A new session took the slot: fresh rotation counter, retirement requests survive. */
	occupy(slotId: string, agentId: string, sessionId: string): void {
		this.db.run(
			`UPDATE slots SET agent_id = ?, session_id = ?, tasks_done = 0, manual = 0,
				status = CASE WHEN status IN ('retiring', 'retired') THEN status ELSE 'occupied' END
			 WHERE id = ?`,
			[agentId, sessionId, slotId],
		);
	}

	setStatus(slotId: string, status: SlotStatus): void {
		this.db.run("UPDATE slots SET status = ? WHERE id = ?", [status, slotId]);
	}

	setManual(slotId: string, manual: boolean): void {
		this.db.run("UPDATE slots SET manual = ? WHERE id = ?", [manual ? 1 : 0, slotId]);
	}

	incrementDone(slotId: string): void {
		this.db.run("UPDATE slots SET tasks_done = tasks_done + 1 WHERE id = ?", [slotId]);
	}

	/** Worker slots not yet retired, machine-wide: what `limits.max_workers_total` caps. */
	countActiveWorkers(): number {
		const row = this.db
			.query("SELECT COUNT(*) AS n FROM slots WHERE kind = 'worker' AND status != 'retired'")
			.get() as { n: number };
		return row.n;
	}

	integratorFor(projectId: string | null, group: string): SlotRow | null {
		return this.forGroup(projectId, group, "integrator")[0] ?? null;
	}

	/** Slot of the given kind recorded for a working directory, if any. */
	byWorktree(path: string, kind: SlotKind = "worker"): SlotRow | null {
		return (
			(this.db
				.query("SELECT * FROM slots WHERE worktree = ? AND kind = ? ORDER BY created_at DESC LIMIT 1")
				.get(path, kind) as SlotRow | null) ?? null
		);
	}
}
