import { createHash } from "node:crypto";
import { basename, dirname, resolve } from "node:path";

export type Role = "personal" | "project" | "group" | "worker";
export const ROLES: Role[] = ["personal", "project", "group", "worker"];

export interface ProjectIdentity {
	id: string;
	name: string;
	root: string;
}

function hash8(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

export function sessionTag(sessionId: string, pool: readonly string[]): string {
	const taken = (length: number): boolean =>
		pool.some((other) => other !== sessionId && other.startsWith(sessionId.slice(0, length)));
	let length = Math.min(13, sessionId.length);
	while (length < sessionId.length && (taken(length) || sessionId[length - 1] === "-")) length++;
	return sessionId.slice(0, length);
}

export function git(cwd: string, args: string[]): string | null {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) return null;
	return proc.stdout.toString().trim();
}

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

export const RANK_GLYPH: Record<Role, string> = {
	personal: "★★★",
	project: "★★",
	group: "★",
	worker: "☆",
};

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

export function displayName(label: string): string {
	return label.replace(/^[★☆]+\s*/u, "");
}
