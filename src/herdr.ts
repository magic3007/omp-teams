/**
 * Thin typed wrapper over the herdr CLI.
 *
 * Every call is one `herdr <cmd>` invocation returning `{id, result}` or
 * `{id, error}` JSON. herdr is only a presentation and launch surface here: the
 * registry stays the source of truth, and pane ids are treated as mutable
 * bindings refreshed on every attach.
 */
import { existsSync } from "node:fs";

export interface HerdrPane {
	pane_id: string;
	tab_id: string;
	workspace_id: string;
	cwd: string;
	label?: string;
	display_agent?: string;
	agent_status?: string;
	state_labels?: Record<string, string>;
	tokens?: Record<string, string>;
}

export type HerdrResult<T> = { ok: true; value: T } | { ok: false; error: string };

function binary(): string {
	const fromEnv = process.env.HERDR_BIN_PATH;
	if (fromEnv && existsSync(fromEnv)) return fromEnv;
	return "herdr";
}

/** herdr is only usable from inside a herdr pane. */
export function herdrAvailable(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(process.env.HERDR_SOCKET_PATH);
}

interface RawResponse {
	id?: string;
	result?: unknown;
	error?: { code?: string; message?: string };
}

function call<T>(args: string[], select: (result: unknown) => T | undefined): HerdrResult<T> {
	const proc = Bun.spawnSync([binary(), ...args], { stdout: "pipe", stderr: "pipe" });
	const stdout = proc.stdout.toString().trim();
	if (!stdout) {
		return { ok: false, error: `herdr ${args.join(" ")} produced no output: ${proc.stderr.toString().trim()}` };
	}
	let parsed: RawResponse;
	try {
		parsed = JSON.parse(stdout) as RawResponse;
	} catch {
		return { ok: false, error: `herdr ${args.join(" ")} returned non-JSON output` };
	}
	if (parsed.error) {
		return { ok: false, error: `herdr ${args.join(" ")} failed: ${parsed.error.message ?? parsed.error.code ?? "unknown"}` };
	}
	const value = select(parsed.result);
	if (value === undefined) return { ok: false, error: `herdr ${args.join(" ")} returned an unexpected shape` };
	return { ok: true, value };
}

/** Commands that answer with nothing on success (`pane run`). */
function callVoid(args: string[]): HerdrResult<true> {
	const proc = Bun.spawnSync([binary(), ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) {
		return { ok: false, error: `herdr ${args.join(" ")} failed: ${proc.stderr.toString().trim() || `exit ${proc.exitCode}`}` };
	}
	const stdout = proc.stdout.toString().trim();
	if (!stdout) return { ok: true, value: true };
	let parsed: RawResponse;
	try {
		parsed = JSON.parse(stdout) as RawResponse;
	} catch {
		return { ok: true, value: true };
	}
	if (parsed.error) {
		return { ok: false, error: `herdr ${args.join(" ")} failed: ${parsed.error.message ?? parsed.error.code ?? "unknown"}` };
	}
	return { ok: true, value: true };
}

function readRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readString(source: Record<string, unknown> | null, key: string): string | undefined {
	const value = source?.[key];
	return typeof value === "string" ? value : undefined;
}

function readPane(value: unknown): HerdrPane | null {
	const record = readRecord(value);
	if (!record) return null;
	const paneId = readString(record, "pane_id");
	const tabId = readString(record, "tab_id");
	const workspaceId = readString(record, "workspace_id");
	if (!paneId || !tabId || !workspaceId) return null;
	return {
		pane_id: paneId,
		tab_id: tabId,
		workspace_id: workspaceId,
		cwd: readString(record, "cwd") ?? "",
		label: readString(record, "label"),
		display_agent: readString(record, "display_agent"),
		agent_status: readString(record, "agent_status"),
		state_labels: readRecord(record["state_labels"]) as Record<string, string> | undefined,
		tokens: readRecord(record["tokens"]) as Record<string, string> | undefined,
	};
}

/**
 * Fire-and-forget herdr call for presence updates: never blocks the caller's
 * event loop, so a slow herdr socket cannot starve the member's heartbeat.
 */
function callDetached(args: string[]): void {
	try {
		const proc = Bun.spawn([binary(), ...args], { stdout: "ignore", stderr: "ignore" });
		proc.unref();
	} catch {
		// Presence is best-effort.
	}
}

export interface HerdrCreated {
	workspaceId?: string;
	tabId: string;
	paneId: string;
}

/** Arguments of one `pane report-metadata` call under the omp-teams source. */
export function metadataArgs(
	paneId: string,
	input: {
		displayAgent?: string;
		stateLabels?: Record<string, string>;
		tokens?: Record<string, string>;
		seq?: number;
		ttlMs?: number;
	},
): string[] {
	const args = ["pane", "report-metadata", paneId, "--source", "omp-teams"];
	if (input.displayAgent) args.push("--display-agent", input.displayAgent);
	for (const [status, text] of Object.entries(input.stateLabels ?? {})) {
		args.push("--state-label", `${status}=${text}`);
	}
	for (const [name, value] of Object.entries(input.tokens ?? {})) {
		args.push("--token", `${name}=${value}`);
	}
	if (input.seq !== undefined) args.push("--seq", String(input.seq));
	if (input.ttlMs !== undefined) args.push("--ttl-ms", String(input.ttlMs));
	return args;
}

export class Herdr {
	createWorkspace(cwd: string, label: string): HerdrResult<HerdrCreated> {
		return call(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"], (result) => {
			const record = readRecord(result);
			const workspaceId = readString(readRecord(record?.["workspace"]), "workspace_id");
			const pane = readPane(record?.["root_pane"]);
			const tabId = readString(readRecord(record?.["tab"]), "tab_id");
			if (!workspaceId || !pane || !tabId) return undefined;
			return { workspaceId, tabId, paneId: pane.pane_id };
		});
	}

	createTab(workspaceId: string, cwd: string, label: string): HerdrResult<HerdrCreated> {
		return call(["tab", "create", "--workspace", workspaceId, "--cwd", cwd, "--label", label, "--no-focus"], (result) => {
			const record = readRecord(result);
			const pane = readPane(record?.["root_pane"]);
			const tabId = readString(readRecord(record?.["tab"]), "tab_id");
			if (!pane || !tabId) return undefined;
			return { tabId, paneId: pane.pane_id };
		});
	}

	splitPane(paneId: string, cwd: string, direction: "right" | "down" = "right"): HerdrResult<HerdrCreated> {
		return call(
			["pane", "split", "--pane", paneId, "--direction", direction, "--cwd", cwd, "--no-focus"],
			(result) => {
				const pane = readPane(readRecord(result)?.["pane"]);
				return pane ? { tabId: pane.tab_id, paneId: pane.pane_id } : undefined;
			},
		);
	}

	renamePane(paneId: string, label: string): HerdrResult<true> {
		return call(["pane", "rename", paneId, label], () => true);
	}

	/** Tab and workspace renames take the label as a positional argument. */
	renameTab(tabId: string, label: string): HerdrResult<true> {
		return call(["tab", "rename", tabId, label], () => true);
	}

	renameWorkspace(workspaceId: string, label: string): HerdrResult<true> {
		return call(["workspace", "rename", workspaceId, label], () => true);
	}

	/** Type a command into a pane's shell and press Enter. */
	runInPane(paneId: string, command: string): HerdrResult<true> {
		// `pane run` answers with an empty body on success.
		return callVoid(["pane", "run", paneId, command]);
	}

	/** Presence update without waiting for herdr: label, state labels, tokens. */
	reportPresence(
		paneId: string,
		input: {
			displayAgent?: string;
			stateLabels?: Record<string, string>;
			tokens?: Record<string, string>;
			seq?: number;
			ttlMs?: number;
		},
		title?: string,
	): void {
		callDetached(metadataArgs(paneId, input));
		if (title) callDetached(["pane", "rename", paneId, title]);
	}

	listPanes(): HerdrResult<HerdrPane[]> {
		return call(["pane", "list"], (result) => {
			const panes = readRecord(result)?.["panes"];
			if (!Array.isArray(panes)) return undefined;
			return panes.map(readPane).filter((pane): pane is HerdrPane => pane !== null);
		});
	}

	/** Close every pane of a workspace. Used only for workspaces this extension created. */
	closeWorkspace(workspaceId: string): HerdrResult<true> {
		return call(["workspace", "close", workspaceId], () => true);
	}
}

/** This session's own pane id, when running inside herdr. */
export function currentPaneId(): string | null {
	const pane = process.env.HERDR_PANE_ID;
	return pane && pane.length > 0 ? pane : null;
}

export function currentWorkspaceId(): string | null {
	const workspace = process.env.HERDR_WORKSPACE_ID;
	return workspace && workspace.length > 0 ? workspace : null;
}
