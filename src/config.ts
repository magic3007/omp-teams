/**
 * Layered configuration for omp-teams.
 *
 * Precedence, lowest to highest:
 *   1. DEFAULTS below
 *   2. `~/.omp/teams/config.yml` (personal defaults)
 *   3. `<project-root>/.omp/teams.yml` (per-project override, usually committed)
 *
 * Only plain objects merge recursively; arrays and scalars replace.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { teamsHome } from "./db";
import { join } from "node:path";

export interface PathRule {
	glob: string;
	kind?: string;
	difficulty?: string;
	model?: string;
}

export interface TeamsConfig {
	models: {
		role: { personal: string; project: string; group: string; integrator: string };
		routing: {
			default: string;
			by_kind: Record<string, string>;
			by_difficulty: Record<string, string>;
		};
		/** Models a manager may name explicitly when assigning. */
		allowed: string[];
		fallback: { worker: string[] };
	};
	path_rules: PathRule[];
	limits: {
		workers_per_tab: number;
		max_workers_total: number;
		worker_max_cost_usd: number;
		/** A member with no heartbeat for this long is considered dead. */
		dead_after_seconds: number;
	};
	/** Mailbox poll interval, also the heartbeat interval. */
	poll_ms: number;
	patrol_minutes: number;
	max_task_failures: number;
	rotate: { tasks: number; context_pct: number };
	report_interval_minutes: number;
	guards: {
		budget: {
			daily_usd: number;
			/**
			 * USD per million tokens, used when a session reports no cost (many
			 * providers ship no price table to omp). Keyed by `provider/model`,
			 * `provider/*`, or `*`; first match wins.
			 */
			prices: Record<string, { input: number; output: number }>;
		};
		/** A group that reports this many blockers within an hour is paused and escalated. 0 disables. */
		group_blocked_per_hour: number;
		/** ISO time before which no new work starts (one-off). */
		quiet_until: string | null;
		/** Local-time window in which new work may start, `HH:MM`; null allows every hour. Wraps past midnight. */
		window: { start: string; end: string } | null;
	};
	rate_limits: {
		/** `progress --fresh` requests one subordinate may send per hour. */
		fresh_per_hour: number;
	};
	/** Root for group and worker git worktrees. */
	worktree_root: string;
	merge: {
		/** Shell command run in the group worktree after each merge; empty disables verification. */
		verify_command: string;
		verify_timeout_seconds: number;
	};
	/** Spawn the integrator slot with the first worker of a group. */
	auto_integrator: boolean;
	/** A task in running state with no report for this long is escalated to the manager. */
	stall_minutes: number;
}

export const DEFAULT_CONFIG: TeamsConfig = {
	models: {
		role: {
			personal: "deepseek/deepseek-flash",
			project: "deepseek/deepseek-flash",
			group: "deepseek/deepseek-flash",
			integrator: "deepseek/deepseek-flash",
		},
		routing: {
			default: "deepseek/deepseek-v4-flash",
			by_kind: {
				merge: "deepseek/deepseek-flash",
				test: "deepseek/deepseek-v4-flash",
				docs: "deepseek/deepseek-flash",
			},
			by_difficulty: {
				trivial: "deepseek/deepseek-flash",
				simple: "deepseek/deepseek-v4-flash",
				normal: "deepseek/deepseek-v4-flash",
				hard: "devin/claude-opus-5-5",
			},
		},
		allowed: [
			"deepseek/deepseek-flash",
			"deepseek/deepseek-v4-flash",
			"devin/claude-opus-5-5-fast",
			"devin/claude-opus-5-5",
		],
		fallback: { worker: ["deepseek/deepseek-v4-pro"] },
	},
	path_rules: [],
	limits: {
		workers_per_tab: 4,
		max_workers_total: 100,
		worker_max_cost_usd: 50,
		dead_after_seconds: 30,
	},
	poll_ms: 2000,
	patrol_minutes: 5,
	max_task_failures: 2,
	rotate: { tasks: 5, context_pct: 70 },
	report_interval_minutes: 15,
	guards: {
		budget: {
			daily_usd: 200,
			prices: { "*": { input: 1, output: 3 } },
		},
		group_blocked_per_hour: 3,
		quiet_until: null,
		window: null,
	},
	rate_limits: { fresh_per_hour: 4 },
	// Worktrees live beside the registry, so OMP_TEAMS_HOME relocates all state at once.
	worktree_root: join(teamsHome(), "wt"),
	merge: { verify_command: "", verify_timeout_seconds: 600 },
	auto_integrator: true,
	stall_minutes: 30,
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively merge `override` into `base` without mutating either. */
export function mergeConfig<T>(base: T, override: unknown): T {
	if (!isPlainObject(override)) return base;
	if (!isPlainObject(base)) return override as T;
	const out: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = (base as Record<string, unknown>)[key];
		out[key] = isPlainObject(value) && isPlainObject(current) ? mergeConfig(current, value) : value;
	}
	return out as T;
}

/** `Bun.YAML` is missing from older `@types/bun` releases, so read it through a narrowed record. */
function bunGlobals(): Record<string, unknown> {
	// Reason: the Bun runtime global is not present in every type environment we compile against.
	return globalThis.Bun as unknown as Record<string, unknown>;
}

function parseYaml(text: string, path: string): unknown {
	const yaml = bunGlobals().YAML;
	if (typeof yaml !== "object" || yaml === null || !("parse" in yaml) || typeof yaml.parse !== "function") {
		throw new Error(`omp-teams: runtime has no YAML parser, cannot read ${path}`);
	}
	return (yaml.parse as (source: string) => unknown)(text);
}

function readYaml(path: string): unknown {
	if (!existsSync(path)) return undefined;
	return parseYaml(readFileSync(path, "utf8"), path) ?? undefined;
}

export function personalConfigPath(home = teamsHome()): string {
	return join(home, "config.yml");
}

export function projectConfigPath(projectRoot: string): string {
	return join(projectRoot, ".omp", "teams.yml");
}

/**
 * Cheap fingerprint of a configuration file pair: size and mtime. Long runs must
 * notice an edited budget or window without a restart.
 */
export function configStamp(projectRoot?: string, home?: string): string {
	const stat = (path: string): string => {
		try {
			const info = statSync(path);
			return `${info.size}:${info.mtimeMs}`;
		} catch {
			return "-";
		}
	};
	return `${stat(personalConfigPath(home))}|${projectRoot ? stat(projectConfigPath(projectRoot)) : ""}`;
}

/** Load defaults, then the personal file, then the project file. */
export function loadConfig(projectRoot?: string, home?: string): TeamsConfig {
	let config = mergeConfig(DEFAULT_CONFIG, readYaml(personalConfigPath(home)));
	if (projectRoot) config = mergeConfig(config, readYaml(projectConfigPath(projectRoot)));
	return config;
}

export const TASK_KINDS = ["merge", "test", "docs", "review", "frontend", "refactor", "infra", "feature", "fix"] as const;
/** Kinds a manager may hand out. Merges are created by the system when a worker reports done. */
export const ASSIGNABLE_KINDS = ["test", "docs", "review", "frontend", "refactor", "infra", "feature", "fix"] as const;
export const TASK_DIFFICULTIES = ["trivial", "simple", "normal", "hard"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];

export interface ModelResolution {
	model: string;
	source: "explicit" | "path_rule" | "by_kind" | "by_difficulty" | "default";
}

/**
 * Resolve the model for one assignment.
 *
 * Order: explicit `model` (must be in `allowed`) > path rule > `by_kind` >
 * `by_difficulty` > `default`. A task that resolves to nothing is rejected
 * instead of silently falling back, so bad configuration surfaces immediately.
 */
export function resolveModel(
	config: TeamsConfig,
	request: { kind?: string; difficulty?: string; model?: string; paths?: string[] },
): ModelResolution | { error: string } {
	if (request.model) {
		if (!config.models.allowed.includes(request.model)) {
			return {
				error: `model "${request.model}" is not in models.allowed (${config.models.allowed.join(", ")})`,
			};
		}
		return { model: request.model, source: "explicit" };
	}

	for (const rule of config.path_rules ?? []) {
		const hit = (request.paths ?? []).some((path) => globMatch(rule.glob, path));
		if (!hit) continue;
		if (rule.model) return { model: rule.model, source: "path_rule" };
		if (rule.kind) request = { ...request, kind: rule.kind };
		if (rule.difficulty) request = { ...request, difficulty: rule.difficulty };
	}

	if (request.kind && config.models.routing.by_kind[request.kind]) {
		return { model: config.models.routing.by_kind[request.kind] as string, source: "by_kind" };
	}
	if (request.difficulty && config.models.routing.by_difficulty[request.difficulty]) {
		return {
			model: config.models.routing.by_difficulty[request.difficulty] as string,
			source: "by_difficulty",
		};
	}
	if (config.models.routing.default) return { model: config.models.routing.default, source: "default" };
	return {
		error: "no model resolved: set models.routing.default in ~/.omp/teams/config.yml",
	};
}

/** Minimal glob matcher: `*`, `**` and `?`, anchored on the whole path. */
export function globMatch(pattern: string, path: string): boolean {
	const normalized = path.replace(/^\.\//, "");
	let regex = "";
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i] as string;
		if (char === "*" && pattern[i + 1] === "*") {
			regex += ".*";
			i++;
			if (pattern[i + 1] === "/") i++;
		} else if (char === "*") {
			regex += "[^/]*";
		} else if (char === "?") {
			regex += "[^/]";
		} else {
			regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
		}
	}
	try {
		return new RegExp(`^${regex}$`).test(normalized);
	} catch {
		return false;
	}
}
