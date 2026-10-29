/**
 * Manager tool policy.
 *
 * A manager never executes work. Registering as a manager narrows the active
 * tool set to read-only inspection plus `teams_*`, and the `tool_call` guard
 * re-checks every call because plan/goal/vibe modes, MCP servers, newly
 * registered extension tools and session resume can all restore tools that
 * `setActiveTools` removed.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Role } from "./identity";

/** Tools a manager may keep: inspection for planning, nothing that mutates. */
export const MANAGER_TOOLS: Record<string, true> = {
	read: true,
	grep: true,
	find: true,
	glob: true,
	lsp: true,
	todo: true,
	web_search: true,
};

export const TEAMS_TOOL_PREFIX = "teams_";

export function isTeamsTool(name: string): boolean {
	return name.startsWith(TEAMS_TOOL_PREFIX);
}

export function isManagerRole(role: Role): boolean {
	return role === "personal" || role === "project" || role === "group";
}

function readOnlyBlockReason(toolName: string, input: unknown, who: string, instead: string): string | null {
	if (isTeamsTool(toolName)) return null;
	if (!MANAGER_TOOLS[toolName]) return `${who}: ${toolName} is not available. ${instead}`;
	if (toolName === "lsp" && typeof input === "object" && input !== null && "action" in input) {
		const action = input.action;
		if (action === "rename" || action === "rename_file") {
			return `${who}: lsp ${String(action)} writes files. ${instead}`;
		}
	}
	return null;
}

/**
 * Why this manager call must be blocked, or null when it may run.
 *
 * `lsp` is read-only except for refactors: `rename` writes workspace edits.
 */
export function managerBlockReason(toolName: string, input: unknown): string | null {
	return readOnlyBlockReason(
		toolName,
		input,
		"managers do not execute work",
		"Assign the task with teams_assign instead.",
	);
}

/** The integrator only merges; the merge itself is the deterministic teams_merge tool. */
export function integratorBlockReason(toolName: string, input: unknown): string | null {
	return readOnlyBlockReason(toolName, input, "the integrator only merges", "Run the merge with teams_merge.");
}

/** Where a worker may write: its own worktree. The rest of the team's git state is off limits. */
export interface WorkerBounds {
	/** The worker's own worktree. */
	worktree: string;
	/** The worker's slot branch. */
	branch: string;
	/** Paths that belong to the team: the main repository and every team worktree. */
	protectedRoots: string[];
}

/** A leading `NAME=value` word is environment for the command that follows. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Shell keywords that end up in front of a command inside one segment. */
const SHELL_PREFIX: Record<string, true> = { do: true, then: true, else: true, elif: true, "!": true };

/**
 * The text of one `$(...)` substitution, kept raw so its brackets never split a
 * word and its arguments are never read as the caller's.
 */
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

/**
 * Split a bash command into segments of words. Unquoted `&&`, `||`, `;`, `|`,
 * `&` and newlines end a segment; quotes group words and lose the quote marks;
 * redirections (`2>/dev/null`, `>&1`, `>out`) are dropped, so they never look
 * like operands.
 */
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
			// A word of digits right before the operator is a file descriptor, not an operand.
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

/** The command of a segment and its arguments, skipping assignments and keywords. */
function commandOf(words: string[]): { name: string; args: string[] } | null {
	let index = 0;
	while (index < words.length && (ASSIGNMENT.test(words[index] ?? "") || SHELL_PREFIX[words[index] ?? ""] === true)) index += 1;
	const name = words[index];
	if (!name) return null;
	return { name, args: words.slice(index + 1) };
}

function expandHome(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return `${homedir()}/${path.slice(2)}`;
	return path;
}

function resolveAgainst(base: string, path: string): string {
	return resolve(base, expandHome(path));
}

/** `--git-dir`/`--work-tree` value; a `/.git` suffix means its parent is the worktree. */
function repositoryTarget(value: string, base: string): string {
	const resolved = resolveAgainst(base, value);
	return resolved.endsWith("/.git") ? resolve(resolved, "..") : resolved;
}

function isFlag(word: string): boolean {
	return word.startsWith("-") && word !== "-";
}

/** An argument list split into flags and operands; `--` alone is a flag. */
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

/** A short-flag cluster such as `-qb` or `-D` contains one of these letters. */
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

/**
 * Ref writes: every worktree shares them, so the directory does not matter.
 * Returns the clause that follows `workers do not`, or null when the command
 * only reads refs.
 */
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

/**
 * Git subcommands that change a worktree or its refs. Branch, worktree and ref
 * writes are covered everywhere by `refWriteClause`, so their read-only forms
 * (`git branch -a`, `git worktree list`) stay allowed here. `stash list` and
 * `stash show` only read, and names such as `merge-base` are not in the set.
 */
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

/**
 * Why this git invocation is blocked, as the clause after `workers do not`, or
 * null when it only reads. The directory it runs in comes from `-C`,
 * `--git-dir` and `--work-tree` when given.
 */
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

/** Follow `cd`/`pushd` so later segments are judged in the directory they run in. */
function changeDirectory(target: string | null, directory: string, bounds: WorkerBounds): string {
	if (!target || target === "-") return homedir();
	if (target.includes("$(") || target.includes("`")) {
		// `cd $(git rev-parse --git-common-dir)/..` lands in the main repository.
		return target.includes("--git-common-dir") ? (bounds.protectedRoots[0] ?? bounds.worktree) : directory;
	}
	return resolveAgainst(directory, target);
}

/** The first blocked segment of a bash command, as the clause after `workers do not`. */
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

/** A path inside the team's protected git state but outside the worker's own worktree. */
function foreignTeamPath(paths: string[], bounds: WorkerBounds): string | null {
	for (const path of paths) {
		if (insideAny(path, [bounds.worktree])) continue;
		if (insideAny(path, bounds.protectedRoots)) return path;
	}
	return null;
}

/**
 * Why this worker call must be blocked, or null when it may run.
 *
 * A worker may read the whole repository but writes only in its own worktree.
 * The bash guard reads each segment's real command, follows `cd`/`pushd`, and
 * resolves `-C`/`--git-dir`/`--work-tree`, so where a command runs decides the
 * answer; ref writes are blocked wherever they run because every worktree
 * shares the refs. File tools resolve their paths the same way.
 *
 * This guards against honest mistakes by a model following a confused task (it
 * blocks the git commands that rewrote a group branch in testing); it is not a
 * sandbox, and the integrator's head check catches what slips through.
 */
export function workerBlockReason(toolName: string, input: unknown, bounds: WorkerBounds | null): string | null {
	if (toolName === "ask") {
		return "the built-in ask tool blocks until a human answers; use teams_ask to reach your group lead instead.";
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

/** Active tools a manager keeps: read-only tools it already had, plus every teams tool. */
export function managerActiveTools(current: string[], teamsTools: string[]): string[] {
	const kept = current.filter((name) => MANAGER_TOOLS[name] || isTeamsTool(name));
	const missing = teamsTools.filter((name) => !kept.includes(name));
	return [...kept, ...missing];
}
