/**
 * Identity helpers: project identity from git, seat keys, display labels.
 *
 * A project is one git repository, identified by its common git directory so
 * every worktree of the same repository maps to the same project.
 */
import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

export type Role = "personal" | "project" | "group" | "worker";
export const ROLES: Role[] = ["personal", "project", "group", "worker"];

export interface ProjectIdentity {
	id: string;
	name: string;
	/** Main repository root, shared by every worktree. */
	root: string;
}

function hash8(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

/**
 * Shortest prefix of the omp session id that tells it apart from every other
 * id in `pool`, at least 13 characters. omp session ids are UUIDv7, whose first
 * 8 hex digits change only about once a minute, so members started together
 * share them; the next 4 digits are the millisecond. `omp -r <tag>` resumes by
 * this prefix.
 */
export function sessionTag(sessionId: string, pool: readonly string[]): string {
	const taken = (length: number): boolean =>
		pool.some((other) => other !== sessionId && other.startsWith(sessionId.slice(0, length)));
	let length = Math.min(13, sessionId.length);
	// Never end on a hyphen: the tag stays a clean, resumable prefix.
	while (length < sessionId.length && (taken(length) || sessionId[length - 1] === "-")) length++;
	return sessionId.slice(0, length);
}

/** Run a git command in `cwd`; returns trimmed stdout or null when it fails. */
export function git(cwd: string, args: string[]): string | null {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return null;
	return proc.stdout.toString().trim();
}

/**
 * Resolve the project that owns `cwd`.
 *
 * Uses `--git-common-dir`, which every worktree of a repository reports as the
 * main repository's `.git`, so all worktrees collapse into one project.
 */
export function resolveProject(cwd: string): ProjectIdentity | null {
	const commonDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
	if (!commonDir) return null;
	const root = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
	const absoluteRoot = resolve(root);
	return { id: `p-${hash8(absoluteRoot)}`, name: basename(absoluteRoot), root: absoluteRoot };
}

export function personalSeat(): string {
	return "personal";
}

export function projectSeat(projectId: string): string {
	return `project:${projectId}`;
}

export function groupSeat(projectId: string, group: string): string {
	return `group:${projectId}/${group}`;
}

/** Worker seats belong to the slot, not the session, so a respawn inherits its mail. */
export function workerSeat(slotId: string): string {
	return `worker:${slotId}`;
}

export function seatFor(
	role: Role,
	options: { slotId?: string | null; projectId?: string | null; group?: string | null },
): string {
	switch (role) {
		case "personal":
			return personalSeat();
		case "project":
			if (!options.projectId) throw new Error("project role requires a project id");
			return projectSeat(options.projectId);
		case "group":
			if (!options.projectId || !options.group) {
				throw new Error("group role requires a project id and a group name");
			}
			return groupSeat(options.projectId, options.group);
		case "worker":
			if (!options.slotId) throw new Error("worker role requires a slot");
			return workerSeat(options.slotId);
	}
}

/** The seat one level above `role`, or null for the top of the tree. */
export function parentSeatFor(
	role: Role,
	projectId?: string | null,
	group?: string | null,
): { seat: string | null; role: Role | null } {
	switch (role) {
		case "personal":
			return { seat: null, role: null };
		case "project":
			return { seat: personalSeat(), role: "personal" };
		case "group":
			if (!projectId) throw new Error("group role requires a project id");
			return { seat: projectSeat(projectId), role: "project" };
		case "worker":
			if (!projectId || !group) throw new Error("worker role requires a project id and a group name");
			return { seat: groupSeat(projectId, group), role: "group" };
	}
}

export function shortId(): string {
	return hash8(`${Date.now()}-${Math.random()}-${process.pid}`);
}

/**
 * Rank glyph per level: the number of stars is the level, a worker gets a hollow
 * star. Used in labels, pane names, tabs and the status line, so the hierarchy
 * reads the same everywhere.
 */
export const RANK_GLYPH: Record<Role, string> = {
	personal: "★★★",
	project: "★★",
	group: "★",
	worker: "☆",
};

/** Human names of the levels, unabbreviated. */
export const ROLE_TITLE: Record<Role, string> = {
	personal: "personal leader",
	project: "repo leader",
	group: "group leader",
	worker: "worker",
};

export function labelFor(
	role: Role,
	options: { projectName?: string; group?: string; index?: number; integrator?: boolean },
): string {
	switch (role) {
		case "personal":
			return `${RANK_GLYPH.personal} ${ROLE_TITLE.personal}`;
		case "project":
			return `${RANK_GLYPH.project} ${ROLE_TITLE.project} · ${options.projectName ?? "repo"}`;
		case "group":
			return `${RANK_GLYPH.group} ${ROLE_TITLE.group} · ${options.group ?? "group"}`;
		case "worker":
			return options.integrator
				? `${RANK_GLYPH.worker} integrator · ${options.group ?? "group"}`
				: `${RANK_GLYPH.worker} ${ROLE_TITLE.worker} ${options.index ?? 1} · ${options.group ?? "group"}`;
	}
}

/** A label without its rank glyph: what the status line prints after its own icon. */
export function displayName(label: string): string {
	return label.replace(/^[★☆]+\s*/u, "");
}
