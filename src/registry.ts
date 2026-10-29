/**
 * Membership registry: one row per member session, one live holder per seat.
 *
 * The registry is the single source of truth for the hierarchy. Herdr layout,
 * status lines and pane titles are projections of these rows.
 */
import type { Database } from "bun:sqlite";
import { logEvent } from "./db";
import {
	groupSeat,
	labelFor,
	parentSeatFor,
	projectSeat,
	type Role,
	seatFor,
	shortId,
} from "./identity";

export type AgentStatus = "alive" | "dead" | "left";

export interface AgentRow {
	id: string;
	seat: string;
	role: Role;
	label: string;
	project_id: string | null;
	project_name: string | null;
	group_name: string | null;
	parent_seat: string | null;
	session_id: string;
	session_file: string | null;
	cwd: string;
	pane_id: string | null;
	model: string | null;
	status: AgentStatus;
	registered_at: number;
	last_seen: number;
}

export interface RegisterInput {
	role: Role;
	cwd: string;
	sessionId: string;
	sessionFile?: string | null;
	paneId?: string | null;
	model?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	group?: string | null;
	/** Worker slot this session occupies. */
	slotId?: string | null;
	/** Slot index, used for the worker label. */
	index?: number;
	/** Integrator slots get a distinct label. */
	slotKind?: "worker" | "integrator";
	/**
	 * Take the seat even when a live holder has it: `/teams <role> --force` (a human
	 * handoff), or a respawn in the same herdr pane (the previous process exited).
	 */
	force?: boolean;
	takeoverPane?: string | null;
}

export type RegisterResult = { ok: true; agent: AgentRow; created: boolean } | { ok: false; error: string };

export interface GroupRow {
	project_id: string;
	name: string;
	worktree: string;
	branch: string;
	base: string | null;
	workspace_id: string | null;
	tab_id: string | null;
	lead_pane_id: string | null;
	created_at: number;
	/** Group lead stopped handing out work; workers do not claim. */
	paused: number;
	/** Why it is paused: `halt`, `budget`, `blocked-rate`, or null for a human pause. */
	paused_reason: string | null;
	/** Group-branch head the integrator last wrote; a different head means someone else rewrote the branch. */
	head_sha: string | null;
}

export class Registry {
	constructor(
		private readonly db: Database,
		private readonly options: { deadAfterMs: number; now?: () => number } = { deadAfterMs: 30_000 },
	) {}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	byId(id: string): AgentRow | null {
		return (this.db.query("SELECT * FROM agents WHERE id = ?").get(id) as AgentRow | null) ?? null;
	}

	bySeat(seat: string): AgentRow | null {
		return (
			(this.db.query("SELECT * FROM agents WHERE seat = ? AND status = 'alive'").get(seat) as AgentRow | null) ??
			null
		);
	}

	bySession(sessionId: string): AgentRow | null {
		return (
			(this.db.query("SELECT * FROM agents WHERE session_id = ? AND status = 'alive'").get(sessionId) as
				| AgentRow
				| null) ?? null
		);
	}

	/** The latest row this session ever held, whatever its status. */
	lastRowOfSession(sessionId: string): AgentRow | null {
		return (
			(this.db
				.query("SELECT * FROM agents WHERE session_id = ? ORDER BY last_seen DESC, rowid DESC LIMIT 1")
				.get(sessionId) as AgentRow | null) ?? null
		);
	}

	/** Mark every member whose heartbeat is older than the deadline as dead. */
	sweepDead(): AgentRow[] {
		const cutoff = this.now() - this.options.deadAfterMs;
		const stale = this.db
			.query("SELECT * FROM agents WHERE status = 'alive' AND last_seen < ?")
			.all(cutoff) as AgentRow[];
		if (stale.length === 0) return [];
		this.db.run("UPDATE agents SET status = 'dead' WHERE status = 'alive' AND last_seen < ?", [cutoff]);
		for (const agent of stale) logEvent(this.db, "dead", { reason: "heartbeat-stale" }, agent.id, this.now());
		return stale;
	}

	/**
	 * Bring back a member that was marked dead while its process was still
	 * running (a stalled event loop, a slow tool), or that is resumed with
	 * `omp -r`. Refused when the member left on purpose or another session holds
	 * the seat now. A resumed session may run in another pane or directory; pass
	 * them so presence goes to the right place.
	 */
	revive(agentId: string, where: { paneId?: string | null; cwd?: string } = {}): AgentRow | null {
		const row = this.byId(agentId);
		if (!row || row.status !== "dead") return null;
		if (this.bySeat(row.seat)) return null;
		try {
			this.db.run(
				`UPDATE agents SET status = 'alive', last_seen = ?, pane_id = COALESCE(?, pane_id), cwd = COALESCE(?, cwd)
				 WHERE id = ? AND status = 'dead'`,
				[this.now(), where.paneId ?? null, where.cwd ?? null, agentId],
			);
		} catch {
			// Another session won the seat between the check and the update.
			return null;
		}
		logEvent(this.db, "revive", { seat: row.seat }, agentId, this.now());
		return this.byId(agentId);
	}

	heartbeat(agentId: string): void {
		this.db.run("UPDATE agents SET last_seen = ? WHERE id = ? AND status = 'alive'", [this.now(), agentId]);
	}

	markStatus(agentId: string, status: AgentStatus): void {
		this.db.run("UPDATE agents SET status = ?, last_seen = ? WHERE id = ?", [status, this.now(), agentId]);
		logEvent(this.db, `status:${status}`, undefined, agentId, this.now());
	}

	/**
	 * Create or refresh this session's membership.
	 *
	 * Re-registering the same session for the same seat updates the row. A seat
	 * held by a live member is a conflict; a seat whose holder stopped
	 * heartbeating is taken over.
	 */
	register(input: RegisterInput): RegisterResult {
		const now = this.now();
		// Reclaim seats of members that stopped heartbeating before judging conflicts.
		this.sweepDead();
		const parent = parentSeatFor(input.role, input.projectId, input.group);
		if (parent.seat) {
			if (!this.bySeat(parent.seat)) {
				return {
					ok: false,
					error: `parent ${parent.role} is not registered. ${nextStepFor(parent.role ?? "personal", input)}`,
				};
			}
		}

		const existingSelf = this.bySession(input.sessionId);
		const id = existingSelf?.id ?? `a-${shortId()}`;
		if (input.role === "worker" && !input.slotId) {
			return { ok: false, error: "worker registration needs a slot; run /teams join <group> or /teams spawn worker <group>" };
		}
		const seat = seatFor(input.role, {
			slotId: input.slotId,
			projectId: input.projectId,
			group: input.group,
		});

		if (existingSelf && existingSelf.seat !== seat) {
			return {
				ok: false,
				error: `this session is already registered as ${existingSelf.label} (${existingSelf.seat}). Run /teams leave first.`,
			};
		}

		const holder = this.bySeat(seat);
		if (holder && holder.session_id !== input.sessionId) {
			const samePane = Boolean(input.takeoverPane) && holder.pane_id === input.takeoverPane;
			if (input.force || samePane) {
				this.db.run("UPDATE agents SET status = 'dead' WHERE id = ?", [holder.id]);
				logEvent(this.db, "takeover", { seat, from: holder.id, reason: input.force ? "force" : "same-pane" }, holder.id, now);
			}
		}

		const index =
			input.role === "worker"
				? (input.index ?? this.nextWorkerIndex(input.projectId ?? null, input.group ?? null))
				: undefined;
		const label = labelFor(input.role, {
			projectName: input.projectName ?? undefined,
			group: input.group ?? undefined,
			index,
			integrator: input.slotKind === "integrator",
		});

		const row = {
			id,
			seat,
			role: input.role,
			label,
			project_id: input.projectId ?? null,
			project_name: input.projectName ?? null,
			group_name: input.group ?? null,
			parent_seat: parent.seat,
			session_id: input.sessionId,
			session_file: input.sessionFile ?? null,
			cwd: input.cwd,
			pane_id: input.paneId ?? null,
			model: input.model ?? null,
			status: "alive" as AgentStatus,
			registered_at: existingSelf?.registered_at ?? now,
			last_seen: now,
		};

		try {
			this.db.transaction(() => {
				this.db.run(
					`INSERT INTO agents (id, seat, role, label, project_id, project_name, group_name, parent_seat,
						session_id, session_file, cwd, pane_id, model, status, registered_at, last_seen)
					 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT(id) DO UPDATE SET seat = excluded.seat, role = excluded.role, label = excluded.label,
						project_id = excluded.project_id, project_name = excluded.project_name,
						group_name = excluded.group_name, parent_seat = excluded.parent_seat,
						session_id = excluded.session_id, session_file = excluded.session_file, cwd = excluded.cwd,
						pane_id = excluded.pane_id, model = excluded.model, status = excluded.status,
						last_seen = excluded.last_seen`,
					[
						row.id,
						row.seat,
						row.role,
						row.label,
						row.project_id,
						row.project_name,
						row.group_name,
						row.parent_seat,
						row.session_id,
						row.session_file,
						row.cwd,
						row.pane_id,
						row.model,
						row.status,
						row.registered_at,
						row.last_seen,
					],
				);
			})();
		} catch (error) {
			const holder = this.bySeat(seat);
			if (holder) {
				return {
					ok: false,
					error: `${seat} is already held by ${holder.label} (session ${holder.session_id.slice(0, 12)}…). Run /teams status there, or wait for it to stop heartbeating.`,
				};
			}
			return { ok: false, error: `registration failed: ${(error as Error).message}` };
		}

		logEvent(this.db, existingSelf ? "reregister" : "register", { role: input.role, seat }, id, now);
		return { ok: true, agent: this.byId(id) as AgentRow, created: !existingSelf };
	}

	private nextWorkerIndex(projectId: string | null, group: string | null): number {
		const row = this.db
			.query(
				"SELECT COUNT(*) AS n FROM agents WHERE role = 'worker' AND project_id IS ? AND group_name IS ?",
			)
			.get(projectId, group) as { n: number } | null;
		return (row?.n ?? 0) + 1;
	}

	childrenOf(seat: string): AgentRow[] {
		return this.db
			.query("SELECT * FROM agents WHERE parent_seat = ? AND status = 'alive' ORDER BY role DESC, label")
			.all(seat) as AgentRow[];
	}

	/** Workers that share this worker's group: mutual visibility inside a group. */
	peersOf(agent: AgentRow): AgentRow[] {
		if (agent.role !== "worker") return [];
		return this.db
			.query(
				`SELECT * FROM agents WHERE role = 'worker' AND status = 'alive'
				 AND project_id IS ? AND group_name IS ? AND id != ?
				 ORDER BY label`,
			)
			.all(agent.project_id, agent.group_name, agent.id) as AgentRow[];
	}

	/** Everything this member may address: itself, its parent, its children, its peers. */
	visibleTo(agent: AgentRow): AgentRow[] {
		const rows = [agent];
		if (agent.parent_seat) {
			const parent = this.bySeat(agent.parent_seat);
			if (parent) rows.push(parent);
		}
		rows.push(...this.childrenOf(agent.seat), ...this.peersOf(agent));
		return rows;
	}

	/** Resolve `parent`, an agent id/prefix, a seat, or a label among what `viewer` may address. */
	resolveRef(viewer: AgentRow, ref: string): AgentRow | null {
		const trimmed = ref.trim();
		if (!trimmed) return null;
		if (trimmed === "parent") return viewer.parent_seat ? this.bySeat(viewer.parent_seat) : null;
		const visible = this.visibleTo(viewer);
		const exact = visible.find(
			(row) => row.id === trimmed || row.seat === trimmed || row.label === trimmed,
		);
		if (exact) return exact;
		const prefixed = visible.filter(
			(row) =>
				row.id.startsWith(trimmed) ||
				row.seat.includes(trimmed) ||
				row.label.toLowerCase().includes(trimmed.toLowerCase()),
		);
		return prefixed.length === 1 ? (prefixed[0] as AgentRow) : null;
	}

	/**
	 * A group by name, machine-wide. Null when no group has that name; the
	 * `ambiguous` flag says several projects do, so the caller must qualify it.
	 */
	groupByName(name: string): { group: GroupRow; ambiguous: boolean } | null {
		const rows = this.db.query("SELECT * FROM groups WHERE name = ?").all(name) as GroupRow[];
		const first = rows[0];
		if (!first) return null;
		return { group: first, ambiguous: rows.length > 1 };
	}

	/** Every registered project, for rebuilds and reports. */
	allProjects(): { id: string; name: string; root: string }[] {
		return this.db.query("SELECT id, name, root FROM projects ORDER BY name").all() as {
			id: string;
			name: string;
			root: string;
		}[];
	}

	projectRoot(projectId: string): string | null {
		const row = this.db.query("SELECT root FROM projects WHERE id = ?").get(projectId) as { root: string } | null;
		return row?.root ?? null;
	}

	upsertProject(id: string, name: string, root: string): void {
		this.db.run(
			`INSERT INTO projects (id, name, root, created_at) VALUES (?, ?, ?, ?)
			 ON CONFLICT(id) DO UPDATE SET name = excluded.name, root = excluded.root`,
			[id, name, root, this.now()],
		);
	}

	group(projectId: string, name: string): GroupRow | null {
		return (
			(this.db.query("SELECT * FROM groups WHERE project_id = ? AND name = ?").get(projectId, name) as
				| GroupRow
				| null) ?? null
		);
	}

	/** Point a member at its pane (a resumed session may run somewhere else). */
	setPane(agentId: string, paneId: string | null, cwd?: string): void {
		this.db.run("UPDATE agents SET pane_id = ?, cwd = COALESCE(?, cwd) WHERE id = ?", [paneId, cwd ?? null, agentId]);
	}

	setProjectWorkspace(projectId: string, workspaceId: string): void {
		this.db.run("UPDATE projects SET workspace_id = ? WHERE id = ?", [workspaceId, projectId]);
	}

	projectWorkspace(projectId: string): string | null {
		const row = this.db.query("SELECT workspace_id FROM projects WHERE id = ?").get(projectId) as {
			workspace_id: string | null;
		} | null;
		return row?.workspace_id ?? null;
	}

	setGroupLayout(
		projectId: string,
		name: string,
		layout: { workspaceId?: string | null; tabId?: string | null; leadPaneId?: string | null },
	): void {
		if (layout.workspaceId !== undefined) {
			this.db.run("UPDATE groups SET workspace_id = ? WHERE project_id = ? AND name = ?", [
				layout.workspaceId,
				projectId,
				name,
			]);
		}
		if (layout.tabId !== undefined) {
			this.db.run("UPDATE groups SET tab_id = ? WHERE project_id = ? AND name = ?", [layout.tabId, projectId, name]);
		}
		if (layout.leadPaneId !== undefined) {
			this.db.run("UPDATE groups SET lead_pane_id = ? WHERE project_id = ? AND name = ?", [
				layout.leadPaneId,
				projectId,
				name,
			]);
		}
	}

	setGroupPaused(projectId: string, name: string, paused: boolean, reason: string | null = null): void {
		this.db.run("UPDATE groups SET paused = ?, paused_reason = ? WHERE project_id = ? AND name = ?", [
			paused ? 1 : 0,
			paused ? reason : null,
			projectId,
			name,
		]);
	}

	/** Every group, machine-wide (the brake needs all of them, not one project). */
	allGroups(): GroupRow[] {
		return this.db.query("SELECT * FROM groups ORDER BY project_id, name").all() as GroupRow[];
	}

	setGroupHead(projectId: string, name: string, sha: string | null): void {
		this.db.run("UPDATE groups SET head_sha = ? WHERE project_id = ? AND name = ?", [sha, projectId, name]);
	}

	/** Create or update a group. The head is recorded only on first sight; the integrator owns it afterwards. */
	upsertGroup(input: {
		projectId: string;
		name: string;
		worktree: string;
		branch: string;
		base?: string | null;
		head?: string | null;
	}): GroupRow {
		this.db.run(
			`INSERT INTO groups (project_id, name, worktree, branch, base, created_at, head_sha) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(project_id, name) DO UPDATE SET worktree = excluded.worktree, branch = excluded.branch,
				base = COALESCE(groups.base, excluded.base), head_sha = COALESCE(groups.head_sha, excluded.head_sha)`,
			[input.projectId, input.name, input.worktree, input.branch, input.base ?? null, this.now(), input.head ?? null],
		);
		return this.group(input.projectId, input.name) as GroupRow;
	}

	/** Whole tree of live members, ordered top-down. */
	allAlive(): AgentRow[] {
		return this.db
			.query(
				`SELECT * FROM agents WHERE status = 'alive'
				 ORDER BY CASE role WHEN 'personal' THEN 0 WHEN 'project' THEN 1 WHEN 'group' THEN 2 ELSE 3 END, label`,
			)
			.all() as AgentRow[];
	}

	conflictFor(role: Role, projectId?: string | null, group?: string | null): AgentRow | null {
		const seat =
			role === "personal"
				? "personal"
				: role === "project"
					? projectSeat(projectId ?? "")
					: role === "group"
						? groupSeat(projectId ?? "", group ?? "")
						: "";
		return seat ? this.bySeat(seat) : null;
	}
}

function nextStepFor(role: Role, input: RegisterInput): string {
	switch (role) {
		case "personal":
			return "Run /teams personal in a session that should own the whole machine.";
		case "project":
			return `Run /teams project in ${input.projectName ?? "this repository"} first.`;
		case "group":
			return `Run /teams group ${input.group ?? "<name>"} in ${input.projectName ?? "this repository"} first.`;
		case "worker":
			return "Parent seat missing; register the group lead first.";
	}
}
