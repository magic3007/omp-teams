/**
 * Deterministic merge of a worker commit into the group branch.
 *
 * The integrator worker triggers this through `teams_merge`; the git work itself
 * is fixed code, so a cheap model can drive merges without ever resolving a
 * conflict by hand. A conflict or a failed verification leaves the group
 * worktree exactly as it was before the attempt.
 */
import { dirtyFiles } from "./worktree";

export interface GitRun {
	code: number;
	stdout: string;
	stderr: string;
}

export function runGit(cwd: string, args: string[]): GitRun {
	const proc = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
	return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString().trim() };
}

export type MergeResult =
	| { kind: "merged"; sha: string; verified: boolean }
	| { kind: "already-merged"; sha: string }
	| { kind: "conflict"; files: string[] }
	| { kind: "verify-failed"; output: string }
	| { kind: "error"; error: string };

export interface MergeOptions {
	/** Shell command run in the worktree after a clean merge; failure reverts the merge. */
	verifyCommand?: string;
	verifyTimeoutMs?: number;
}

function tail(text: string, lines: number): string {
	return text.split("\n").slice(-lines).join("\n");
}

export function mergeIntoGroup(worktree: string, sha: string, message: string, options: MergeOptions = {}): MergeResult {
	const dirty = dirtyFiles(worktree);
	if (dirty.length > 0) {
		return { kind: "error", error: `group worktree ${worktree} has uncommitted changes: ${dirty.slice(0, 5).join(", ")}` };
	}
	const target = runGit(worktree, ["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
	if (target.code !== 0) return { kind: "error", error: `${sha} is not a commit reachable from ${worktree}` };

	const ancestor = runGit(worktree, ["merge-base", "--is-ancestor", sha, "HEAD"]);
	const head = runGit(worktree, ["rev-parse", "HEAD"]).stdout;
	if (ancestor.code === 0) return { kind: "already-merged", sha: head };

	const merge = runGit(worktree, ["merge", "--no-ff", "--no-edit", "-m", message, sha]);
	if (merge.code !== 0) {
		const conflicted = runGit(worktree, ["diff", "--name-only", "--diff-filter=U"]).stdout;
		runGit(worktree, ["merge", "--abort"]);
		const files = conflicted.split("\n").filter(Boolean);
		if (files.length > 0) return { kind: "conflict", files };
		return { kind: "error", error: tail(merge.stderr || merge.stdout, 10) };
	}

	if (options.verifyCommand?.trim()) {
		const verify = Bun.spawnSync(["sh", "-c", options.verifyCommand], {
			cwd: worktree,
			stdout: "pipe",
			stderr: "pipe",
			timeout: options.verifyTimeoutMs ?? 600_000,
		});
		if (verify.exitCode !== 0) {
			// The merge commit was created by this call in an integrator-owned worktree: undo it.
			runGit(worktree, ["reset", "--hard", head]);
			const output = `${verify.stdout.toString()}\n${verify.stderr.toString()}`.trim();
			return { kind: "verify-failed", output: tail(output || `exit ${verify.exitCode}`, 40) };
		}
	}
	return { kind: "merged", sha: runGit(worktree, ["rev-parse", "HEAD"]).stdout, verified: Boolean(options.verifyCommand?.trim()) };
}
