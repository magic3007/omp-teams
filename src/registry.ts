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

export type AgentStatus = "alive" | "parked" | "dead" | "left";

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
	slotId?: string | null;
	index?: number;
	slotKind?: "worker" | "integrator";
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
	paused: number;
	paused_reason: string | null;
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

	holder(seat: string): AgentRow | null {
		return (
			(this.db
				.query("SELECT * FROM agents WHERE seat = ? AND status IN ('alive','parked')")
				.get(seat) as AgentRow | null) ?? null
		);
	}

	bySession(sessionId: string): AgentRow | null {
		return (
			(this.db.query("SELECT * FROM agents WHERE session_id = ? AND status = 'alive'").get(sessionId) as
				| AgentRow
				| null) ?? null
		);
	}

	lastRowOfSession(sessionId: string): AgentRow | null {
		return (
			(this.db
				.query("SELECT * FROM agents WHERE session_id = ? ORDER BY last_seen DESC, rowid DESC LIMIT 1")
				.get(sessionId) as AgentRow | null) ?? null
		);
	}

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

	revive(agentId: string, where: { paneId?: string | null; cwd?: string } = {}): AgentRow | null {
		const row = this.byId(agentId);
		if (!row || (row.status !== "dead" && row.status !== "parked")) return null;
		if (this.bySeat(row.seat)) return null;
		try {
			this.db.run(
				`UPDATE agents SET status = 'alive', last_seen = ?, pane_id = COALESCE(?, pane_id), cwd = COALESCE(?, cwd)
				 WHERE id = ? AND status IN ('dead','parked')`,
				[this.now(), where.paneId ?? null, where.cwd ?? null, agentId],
			);
		} catch {
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

	register(input: RegisterInput): RegisterResult {
		const now = this.now();
		this.sweepDead();
		const parent = parentSeatFor(input.role, input.projectId, input.group);
		if (parent.seat) {
			if (!this.holder(parent.seat)) {
				return {
					ok: false,
					error: `parent ${parent.role} is not registered. ${nextStepFor(parent.role ?? "personal", input)}`,
				};
			}
		}

		if (input.role === "worker" && !input.slotId) {
			return { ok: false, error: "worker registration needs a slot; run /teams join <group> or /teams spawn worker <group>" };
		}
		const seat = seatFor(input.role, {
			slotId: input.slotId,
			projectId: input.projectId,
			group: input.group,
		});

		const holder = this.holder(seat);
		const self = this.bySession(input.sessionId) ?? (holder?.session_id === input.sessionId ? holder : null);
		if (self && self.seat !== seat) {
			return {
				ok: false,
				error: `this session is already registered as ${self.label} (${self.seat}). Run /teams leave first.`,
			};
		}
		if (holder && holder.session_id !== input.sessionId) {
			const samePane = Boolean(input.takeoverPane) && holder.pane_id === input.takeoverPane;
			if (input.force || samePane) {
				this.db.run("UPDATE agents SET status = 'dead' WHERE id = ?", [holder.id]);
				logEvent(this.db, "takeover", { seat, from: holder.id, reason: input.force ? "force" : "same-pane" }, holder.id, now);
			} else {
				return {
					ok: false,
					error: `${seat} is already held by ${holder.label} (session ${holder.session_id.slice(0, 12)}…). ${
						holder.status === "parked"
							? "It is parked and waits for work; it takes the seat back when it wakes."
							: "Run /teams status there, or wait for it to stop heartbeating."
					}`,
				};
			}
		}

		const id = self?.id ?? `a-${shortId()}`;

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
			registered_at: self?.registered_at ?? now,
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
			const taken = this.holder(seat);
			if (taken) {
				return {
					ok: false,
					error: `${seat} is already held by ${taken.label} (session ${taken.session_id.slice(0, 12)}…). Run /teams status there, or wait for it to stop heartbeating.`,
				};
			}
			return { ok: false, error: `registration failed: ${(error as Error).message}` };
		}

		logEvent(this.db, self ? "reregister" : "register", { role: input.role, seat }, id, now);
		return { ok: true, agent: this.byId(id) as AgentRow, created: !self };
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
			.query("SELECT * FROM agents WHERE parent_seat = ? AND status IN ('alive','parked') ORDER BY role DESC, label")
			.all(seat) as AgentRow[];
	}

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

	visibleTo(agent: AgentRow): AgentRow[] {
		const rows = [agent];
		if (agent.parent_seat) {
			const parent = this.holder(agent.parent_seat);
			if (parent) rows.push(parent);
		}
		rows.push(...this.childrenOf(agent.seat), ...this.peersOf(agent));
		return rows;
	}

	resolveRef(viewer: AgentRow, ref: string): AgentRow | null {
		const trimmed = ref.trim();
		if (!trimmed) return null;
		if (trimmed === "parent") return viewer.parent_seat ? this.holder(viewer.parent_seat) : null;
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

	groupByName(name: string): { group: GroupRow; ambiguous: boolean } | null {
		const rows = this.db.query("SELECT * FROM groups WHERE name = ?").all(name) as GroupRow[];
		const first = rows[0];
		if (!first) return null;
		return { group: first, ambiguous: rows.length > 1 };
	}

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

	allGroups(): GroupRow[] {
		return this.db.query("SELECT * FROM groups ORDER BY project_id, name").all() as GroupRow[];
	}

	setGroupHead(projectId: string, name: string, sha: string | null): void {
		this.db.run("UPDATE groups SET head_sha = ? WHERE project_id = ? AND name = ?", [sha, projectId, name]);
	}

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

	allAlive(): AgentRow[] {
		return this.db
			.query(
				`SELECT * FROM agents WHERE status = 'alive'
				 ORDER BY CASE role WHEN 'personal' THEN 0 WHEN 'project' THEN 1 WHEN 'group' THEN 2 ELSE 3 END, label`,
			)
			.all() as AgentRow[];
	}

	allHolders(): AgentRow[] {
		return this.db
			.query(
				`SELECT * FROM agents WHERE status IN ('alive','parked')
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
