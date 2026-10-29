/**
 * The surface the omp extension exposes to its command and tool handlers.
 *
 * Kept free of omp types so handler modules stay testable and the extension
 * entry point owns all runtime wiring.
 */
import type { Database } from "bun:sqlite";
import type { AgentRow } from "./registry";
import type { TeamsRuntime } from "./runtime";

export interface TeamsHost {
	readonly runtime: TeamsRuntime;
	/** This session's membership row, or null when the session is not in a team. */
	me(): AgentRow | null;
	/** Re-read this session's row from the registry (after register/takeover). */
	refresh(): AgentRow | null;
	/** Recompute the active tool set for the current role. */
	applyToolPolicy(): Promise<void>;
	/** Names of every `teams_*` tool this extension registered. */
	teamsTools(): string[];
	/** Shared registry database, for reports and audits. */
	readonly db: Database;
	notify(message: string, level?: "info" | "warn" | "error"): void;
	/** Desktop notification through herdr, best-effort (no-op outside herdr). */
	notifyHerdr(title: string, body: string): Promise<void>;
	/**
	 * End this member's process for good: write the launcher stop file (so the
	 * launcher loop does not restart it) and shut the session down.
	 */
	stopMember(): void;
}
