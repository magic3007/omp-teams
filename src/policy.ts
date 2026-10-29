import { homedir } from "node:os";
import { resolve } from "node:path";
import { expandHome, type Role } from "./identity";

export type ToolSeat = Role | "integrator";

export const TEAMS_TOOLS_FOR: Record<ToolSeat, readonly string[]> = {
	personal: ["teams_assign", "teams_progress", "teams_ask", "teams_close", "teams_write_report"],
	project: ["teams_forward", "teams_report", "teams_progress", "teams_ask", "teams_pause", "teams_close", "teams_write_report"],
	group: [
		"teams_forward",
		"teams_report",
		"teams_progress",
		"teams_queue",
		"teams_ask",
		"teams_pause",
		"teams_retire",
		"teams_close",
		"teams_write_report",
	],
	worker: ["teams_report", "teams_ask", "teams_queue"],
	integrator: ["teams_merge", "teams_report"],
};

export const TEAMS_TOOL_PREFIX = "teams_";

export function isTeamsTool(name: string): boolean {
	return name.startsWith(TEAMS_TOOL_PREFIX);
}

export function isManagerRole(role: Role): boolean {
	return role === "personal" || role === "project" || role === "group";
}

const LEADER_BLOCK: Record<Exclude<ToolSeat, "worker">, (toolName: string) => string> = {
	personal: (toolName) =>
		`leaders only route: ${toolName} is not available. Send the request to its repository with teams_assign.`,
	project: (toolName) =>
		`leaders only route: ${toolName} is not available. Pass your task to a group with teams_forward.`,
	group: (toolName) => `leaders only route: ${toolName} is not available. Queue your task with teams_forward.`,
	integrator: (toolName) =>
		`the integrator only merges: ${toolName} is not available. Run the merge with teams_merge.`,
};

export function leaderBlockReason(seat: Exclude<ToolSeat, "worker">, toolName: string): string | null {
	if (TEAMS_TOOLS_FOR[seat].includes(toolName)) return null;
	return LEADER_BLOCK[seat](toolName);
}

export interface WorkerBounds {
	worktree: string;
	branch: string;
	protectedRoots: string[];
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const SHELL_PREFIX: Record<string, true> = { do: true, then: true, else: true, elif: true, "!": true };

function substitution(command: string, start: number): [string, number] {
	let depth = 0;
	let index = start + 1;
	while (index < command.length) {
		const char = command[index];
		if (char === "(") depth += 1;
		else if (char === ")") {
			depth -= 1;
			if (depth === 0) return [command.slice(start, index + 1), index + 1];
		} else if (char === "'" || char === '"' || char === "`") {
			const close = command.indexOf(char, index + 1);
			index = close === -1 ? command.length : close;
		}
		index += 1;
	}
	return [command.slice(start), command.length];
}

function tokenizeBash(command: string): string[][] {
	const segments: string[][] = [];
	let words: string[] = [];
	let word = "";
	let started = false;
	let index = 0;

	const endWord = () => {
		if (started) words.push(word);
		word = "";
		started = false;
	};
	const endSegment = () => {
		endWord();
		if (words.length > 0) segments.push(words);
		words = [];
	};

	while (index < command.length) {
		const char = command[index] ?? "";
		if (char === "'") {
			started = true;
			index += 1;
			while (index < command.length && command[index] !== "'") {
				word += command[index];
				index += 1;
			}
			index += 1;
			continue;
		}
		if (char === '"') {
			started = true;
			index += 1;
			while (index < command.length && command[index] !== '"') {
				const inner = command[index] ?? "";
				if (inner === "\\" && index + 1 < command.length) {
					const next = command[index + 1] ?? "";
					word += next === '"' || next === "\\" || next === "$" || next === "`" ? next : `\\${next}`;
					index += 2;
					continue;
				}
				word += inner;
				index += 1;
			}
			index += 1;
			continue;
		}
		if (char === "\\" && index + 1 < command.length) {
			started = true;
			word += command[index + 1];
			index += 2;
			continue;
		}
		if (char === "$" && command[index + 1] === "(") {
			const [text, next] = substitution(command, index);
			started = true;
			word += text;
			index = next;
			continue;
		}
		if (char === "`") {
			started = true;
			const close = command.indexOf("`", index + 1);
			const end = close === -1 ? command.length : close;
			word += command.slice(index, end + 1);
			index = end + 1;
			continue;
		}
		if (char === ">" || char === "<") {
			if (/^\d+$/.test(word)) {
				word = "";
				started = false;
			}
			endWord();
			index += 1;
			while (index < command.length && "><&".includes(command[index] ?? "")) index += 1;
			while (index < command.length && (command[index] === " " || command[index] === "\t")) index += 1;
			const quote = command[index] === '"' || command[index] === "'" ? command[index] : null;
			if (quote) {
				const close = command.indexOf(quote, index + 1);
				index = close === -1 ? command.length : close + 1;
			} else {
				while (index < command.length && !/[\s|;&]/.test(command[index] ?? "")) index += 1;
			}
			continue;
		}
		if (char === "&" || char === "|" || char === ";" || char === "\n") {
			endSegment();
			index += char !== ";" && char !== "\n" && command[index + 1] === char ? 2 : 1;
			continue;
		}
		if (/\s/.test(char)) {
			endWord();
			index += 1;
			continue;
		}
		started = true;
		word += char;
		index += 1;
	}
	endSegment();
	return segments;
}

function commandOf(words: string[]): { name: string; args: string[] } | null {
	let index = 0;
	while (index < words.length && (ASSIGNMENT.test(words[index] ?? "") || SHELL_PREFIX[words[index] ?? ""] === true)) index += 1;
	const name = words[index];
	if (!name) return null;
	return { name, args: words.slice(index + 1) };
}

function resolveAgainst(base: string, path: string): string {
	return resolve(base, expandHome(path));
}

function repositoryTarget(value: string, base: string): string {
	const resolved = resolveAgainst(base, value);
	return resolved.endsWith("/.git") ? resolve(resolved, "..") : resolved;
}

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

function splitArgs(args: string[]): { flags: string[]; operands: string[] } {
	const flags: string[] = [];
	const operands: string[] = [];
	for (const arg of args) {
		if (isFlag(arg)) flags.push(arg);
		else operands.push(arg);
	}
	return { flags, operands };
}

function hasLong(flags: string[], names: string[]): boolean {
	return flags.some((flag) => flag.startsWith("--") && names.some((name) => flag === name || flag.startsWith(`${name}=`)));
}

function hasShort(flags: string[], letters: Record<string, true>): boolean {
	return flags.some((flag) => !flag.startsWith("--") && [...flag.slice(1)].some((letter) => letters[letter] === true));
}

const BRANCH_WRITE_LONG = ["--force", "--delete", "--move", "--copy"];
const BRANCH_WRITE_SHORT: Record<string, true> = { f: true, d: true, D: true, m: true, M: true, c: true, C: true };
const BRANCH_READ_LONG = [
	"--all",
	"--remotes",
	"--list",
	"--verbose",
	"--contains",
	"--no-contains",
	"--merged",
	"--no-merged",
	"--points-at",
	"--show-current",
	"--format",
	"--sort",
	"--column",
	"--no-column",
	"--color",
	"--no-color",
];
const BRANCH_READ_SHORT: Record<string, true> = { a: true, r: true, l: true, v: true };
const TAG_WRITE_LONG = ["--delete", "--force"];
const TAG_WRITE_SHORT: Record<string, true> = { d: true, f: true };
const TAG_READ_LONG = [
	"--list",
	"--contains",
	"--no-contains",
	"--points-at",
	"--merged",
	"--no-merged",
	"--sort",
	"--format",
	"--verify",
];
const TAG_READ_SHORT: Record<string, true> = { l: true, v: true };
const CHECKOUT_CREATE_SHORT: Record<string, true> = { b: true, B: true };
const SYMBOLIC_REF_WRITE_SHORT: Record<string, true> = { d: true };

function refWriteClause(subcommand: string, args: string[]): string | null {
	if (subcommand === "switch") return "switch branches";
	if (subcommand === "checkout") {
		const { flags } = splitArgs(args);
		if (hasLong(flags, ["--orphan", "--ignore-other-worktrees"]) || hasShort(flags, CHECKOUT_CREATE_SHORT)) {
			return "create or switch branches";
		}
		return null;
	}
	if (subcommand === "branch") {
		const { flags, operands } = splitArgs(args);
		if (hasLong(flags, BRANCH_WRITE_LONG) || hasShort(flags, BRANCH_WRITE_SHORT)) return "move, delete or copy branches";
		if (hasLong(flags, BRANCH_READ_LONG) || hasShort(flags, BRANCH_READ_SHORT)) return null;
		return operands.length > 0 ? "create branches" : null;
	}
	if (subcommand === "tag") {
		const { flags, operands } = splitArgs(args);
		if (hasLong(flags, TAG_WRITE_LONG) || hasShort(flags, TAG_WRITE_SHORT)) return "move, delete or create tags";
		const reads = hasLong(flags, TAG_READ_LONG) || hasShort(flags, TAG_READ_SHORT) || flags.some((flag) => /^-n\d*$/.test(flag));
		return !reads && operands.length > 0 ? "create tags" : null;
	}
	if (subcommand === "update-ref") return "rewrite refs";
	if (subcommand === "symbolic-ref") {
		const { flags, operands } = splitArgs(args);
		if (hasLong(flags, ["--delete"]) || hasShort(flags, SYMBOLIC_REF_WRITE_SHORT) || operands.length >= 2) return "rewrite refs";
		return null;
	}
	if (subcommand === "push") return "push";
	if (subcommand === "worktree") {
		const action = splitArgs(args).operands[0];
		if (action === "add" || action === "remove" || action === "move" || action === "prune") return "add or remove worktrees";
		return null;
	}
	return null;
}

const GIT_WRITE_SUBCOMMANDS: Record<string, true> = {
	add: true,
	am: true,
	apply: true,
	checkout: true,
	"cherry-pick": true,
	clean: true,
	commit: true,
	fetch: true,
	merge: true,
	mv: true,
	pull: true,
	push: true,
	rebase: true,
	reset: true,
	restore: true,
	revert: true,
	rm: true,
	stash: true,
	switch: true,
};

function gitClause(args: string[], directory: string, bounds: WorkerBounds): string | null {
	let target = directory;
	let index = 0;
	let subcommand: string | null = null;
	let rest: string[] = [];
	while (index < args.length) {
		const arg = args[index] ?? "";
		if (arg === "-C" && index + 1 < args.length) {
			target = resolveAgainst(target, args[index + 1] ?? "");
			index += 2;
			continue;
		}
		if (arg.startsWith("-C") && arg.length > 2) {
			target = resolveAgainst(target, arg.slice(2));
			index += 1;
			continue;
		}
		if ((arg === "--git-dir" || arg === "--work-tree") && index + 1 < args.length) {
			target = repositoryTarget(args[index + 1] ?? "", target);
			index += 2;
			continue;
		}
		if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
			target = repositoryTarget(arg.slice(arg.indexOf("=") + 1), target);
			index += 1;
			continue;
		}
		if (arg === "-c" && index + 1 < args.length) {
			index += 2;
			continue;
		}
		if (arg.startsWith("-c") && arg.length > 2) {
			index += 1;
			continue;
		}
		if (isFlag(arg)) {
			index += 1;
			continue;
		}
		subcommand = arg;
		rest = args.slice(index + 1);
		break;
	}
	if (subcommand === null) return null;
	const ref = refWriteClause(subcommand, rest);
	if (ref) return ref;
	if (GIT_WRITE_SUBCOMMANDS[subcommand] !== true) return null;
	if (subcommand === "stash" && (rest[0] === "list" || rest[0] === "show")) return null;
	const foreign = foreignTeamPath([target], bounds);
	return foreign ? `change git state outside their own worktree (${foreign})` : null;
}

function changeDirectory(target: string | null, directory: string, bounds: WorkerBounds): string {
	if (!target || target === "-") return homedir();
	if (target.includes("$(") || target.includes("`")) {
		return target.includes("--git-common-dir") ? (bounds.protectedRoots[0] ?? bounds.worktree) : directory;
	}
	return resolveAgainst(directory, target);
}

function bashClause(command: string, cwd: string | null, bounds: WorkerBounds): string | null {
	let directory = resolveAgainst(bounds.worktree, cwd ?? ".");
	for (const words of tokenizeBash(command)) {
		const segment = commandOf(words);
		if (!segment) continue;
		if (segment.name === "cd" || segment.name === "pushd") {
			directory = changeDirectory(segment.args.find((arg) => !isFlag(arg)) ?? null, directory, bounds);
			continue;
		}
		if (segment.name !== "git" && !segment.name.endsWith("/git")) continue;
		const clause = gitClause(segment.args, directory, bounds);
		if (clause) return clause;
	}
	return null;
}

function insideAny(path: string, roots: string[]): string | null {
	return roots.find((root) => path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)) ?? null;
}

function foreignTeamPath(paths: string[], bounds: WorkerBounds): string | null {
	for (const path of paths) {
		if (insideAny(path, [bounds.worktree])) continue;
		if (insideAny(path, bounds.protectedRoots)) return path;
	}
	return null;
}

export function workerBlockReason(toolName: string, input: unknown, bounds: WorkerBounds | null): string | null {
	if (toolName === "ask") {
		return "the built-in ask tool blocks until a human answers; use teams_ask to reach your group lead instead.";
	}
	if (isTeamsTool(toolName) && !TEAMS_TOOLS_FOR.worker.includes(toolName)) {
		return `workers do not route: ${toolName} is not available. Report to your group leader with teams_report.`;
	}
	if (!bounds || typeof input !== "object" || input === null) return null;
	const rules = `You work only in ${bounds.worktree} on branch ${bounds.branch}; commit there and report the SHA. The integrator merges it.`;

	if (toolName === "bash") {
		const command = "command" in input && typeof input.command === "string" ? input.command : "";
		const cwd = "cwd" in input && typeof input.cwd === "string" ? input.cwd : null;
		const clause = bashClause(command, cwd, bounds);
		return clause ? `workers do not ${clause}. ${rules}` : null;
	}

	if (toolName === "edit" || toolName === "write" || toolName === "ast_edit") {
		const paths: string[] = [];
		if ("path" in input && typeof input.path === "string") paths.push(input.path);
		if ("paths" in input && Array.isArray(input.paths)) {
			for (const path of input.paths) if (typeof path === "string") paths.push(path);
		}
		const foreign = foreignTeamPath(
			paths.map((path) => resolveAgainst(bounds.worktree, path)),
			bounds,
		);
		if (foreign) return `workers do not edit files outside their own worktree (${foreign}). ${rules}`;
	}
	return null;
}
