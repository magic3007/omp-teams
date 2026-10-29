import type { Database } from "bun:sqlite";
import type { AgentRow } from "./registry";
import type { TeamsRuntime } from "./runtime";

export interface TeamsHost {
	readonly runtime: TeamsRuntime;
	me(): AgentRow | null;
	refresh(): AgentRow | null;
	applyToolPolicy(): Promise<void>;
	teamsTools(): string[];
	readonly db: Database;
	notify(message: string, level?: "info" | "warn" | "error"): void;
	notifyHerdr(title: string, body: string): Promise<void>;
	stopMember(): void;
}
