/**
 * Git worktree operations for groups and workers.
 *
 * Workers never share a checkout: each slot gets its own worktree and branch so
 * two agents can never write the same file, and `git add -A` can never capture
 * another agent's half-finished work.
 */
import { existsSync } from "node:fs";
import { git } from "./identity";

export interface WorktreeResult {
	ok: boolean;
	error?: string;
}

/** Create a worktree on a new branch; an existing branch is checked out instead of created. */
export function addWorktree(repoRoot: string, path: string, branch: string, base?: string): WorktreeResult {
	if (existsSync(path)) {
		const existing = git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
		if (existing === null) return { ok: false, error: `${path} exists but is not a git worktree` };
		return { ok: true };
	}
	const branchExists = git(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]) !== null;
	const args = branchExists
		? ["worktree", "add", path, branch]
		: ["worktree", "add", path, "-b", branch, base ?? "HEAD"];
	const added = git(repoRoot, args);
	if (added === null) {
		return { ok: false, error: `git worktree add failed for ${path} on branch ${branch}` };
	}
	return { ok: true };
}

export function currentBranch(dir: string): string | null {
	return git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
}

/** Whether `sha` names a commit reachable from the worktree's HEAD. Rejects invented SHAs. */
export function commitExists(dir: string, sha: string): boolean {
	if (!/^[0-9a-f]{7,40}$/i.test(sha)) return false;
	const resolved = git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
	return resolved !== null;
}

/** Uncommitted changes in the worktree, if any. */
export function dirtyFiles(dir: string): string[] {
	const status = git(dir, ["status", "--porcelain"]);
	if (!status) return [];
	return status.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function branchHead(dir: string): string | null {
	return git(dir, ["rev-parse", "HEAD"]);
}

/** Whether `sha` is already contained in `ref` of the repository at `dir`. */
export function isAncestor(dir: string, sha: string, ref: string): boolean {
	const proc = Bun.spawnSync(["git", "-C", dir, "merge-base", "--is-ancestor", sha, ref], { stdout: "pipe", stderr: "pipe" });
	return proc.exitCode === 0;
}

/**
 * What `ref` changes since it left `base`: `git diff --name-status base...ref`,
 * one "A path" / "M path" / "D path" line per file. Null when git fails.
 */
export function changedFiles(dir: string, base: string, ref: string): string[] | null {
	const out = git(dir, ["diff", "--name-status", `${base}...${ref}`]);
	if (out === null) return null;
	return out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.replace(/\t+/g, " "));
}
