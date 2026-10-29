import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { integratorBlockReason, managerBlockReason, workerBlockReason, type WorkerBounds } from "../src/policy";

const bounds: WorkerBounds = {
	worktree: "/teams/wt/p-1/feat-x/w1",
	branch: "teams-w/feat-x/w1",
	protectedRoots: ["/src/repo", "/teams/wt/p-1"],
};

const homeBounds: WorkerBounds = {
	worktree: `${homedir()}/teams/wt/p-1/feat-x/w1`,
	branch: "teams-w/feat-x/w1",
	protectedRoots: [`${homedir()}/src/repo`, `${homedir()}/teams/wt/p-1`],
};

const bash = (command: string, cwd?: string, within: WorkerBounds = bounds) =>
	workerBlockReason("bash", { command, ...(cwd ? { cwd } : {}) }, within);

describe("worker guard", () => {
	test("the git commands that rewrote a group branch in testing are blocked", () => {
		// Seen verbatim in a live run: a worker force-moved the group branch from the main repository.
		expect(bash("cd /src/repo\ngit branch -f teams/feat-x f510b6b")).toContain("move, delete or copy branches");
		expect(bash("git checkout -b worker/colors main")).toContain("create or switch branches");
		expect(bash("cd /src/repo && git worktree add /tmp/int-wt -B team/x main")).toContain("add or remove worktrees");
		expect(bash("git update-ref refs/heads/teams/feat-x HEAD")).toContain("rewrite refs");
		expect(bash("git push origin HEAD")).toContain("push");
		expect(bash("git switch main")).toContain("switch branches");
	});

	test("writing git state in another team worktree or the main repository is blocked", () => {
		expect(bash("git -C /teams/wt/p-1/feat-x/group reset --hard HEAD~1")).toContain("outside their own worktree");
		expect(bash("git commit -am x", "/src/repo")).toContain("outside their own worktree");
		expect(bash("cd /teams/wt/p-1/feat-x/w2 && git add . && git commit -m x")).toContain("outside their own worktree");
	});

	test("ordinary work in the worker's own worktree is allowed", () => {
		expect(bash("git add -A && git commit -m 'add colors'")).toBeNull();
		expect(bash("git rebase teams/feat-x")).toBeNull();
		expect(bash("git reset --hard HEAD~1")).toBeNull();
		expect(bash("git -C /teams/wt/p-1/feat-x/w1 commit -am fix")).toBeNull();
		expect(bash("git checkout -- src/app.ts")).toBeNull();
		expect(bash("git branch --show-current")).toBeNull();
		expect(bash("bun test && git rev-parse HEAD")).toBeNull();
	});

	test("reading other team git state is allowed", () => {
		expect(bash("git -C /src/repo log --oneline -5")).toBeNull();
		expect(bash("git -C /teams/wt/p-1/feat-x/group show HEAD:colors.txt")).toBeNull();
		expect(bash("cat /src/repo/README.md")).toBeNull();
	});

	test("file edits outside the worker's worktree are blocked, scratch space is not", () => {
		expect(workerBlockReason("write", { path: "/src/repo/colors.txt", content: "x" }, bounds)).toContain("outside their own worktree");
		expect(workerBlockReason("edit", { path: "/teams/wt/p-1/feat-x/group/a.ts" }, bounds)).toContain("outside their own worktree");
		expect(workerBlockReason("edit", { paths: ["/teams/wt/p-1/feat-x/w1/a.ts", "/teams/wt/p-1/feat-x/w2/b.ts"] }, bounds)).toContain(
			"w2/b.ts",
		);
		expect(workerBlockReason("write", { path: "/teams/wt/p-1/feat-x/w1/colors.txt", content: "x" }, bounds)).toBeNull();
		expect(workerBlockReason("write", { path: "/tmp/scratch.txt", content: "x" }, bounds)).toBeNull();
		expect(workerBlockReason("write", { path: "relative/colors.txt", content: "x" }, bounds)).toBeNull();
	});

	test("the built-in ask tool is blocked for every worker", () => {
		expect(workerBlockReason("ask", {}, null)).toContain("teams_ask");
	});
});

describe("manager and integrator guards", () => {
	test("managers keep inspection tools and lose everything that executes", () => {
		expect(managerBlockReason("read", { path: "/x" })).toBeNull();
		expect(managerBlockReason("teams_assign", {})).toBeNull();
		expect(managerBlockReason("bash", { command: "ls" })).toContain("managers do not execute work");
		expect(managerBlockReason("learn", {})).toContain("managers do not execute work");
		expect(managerBlockReason("lsp", { action: "rename" })).toContain("writes files");
		expect(managerBlockReason("lsp", { action: "references" })).toBeNull();
	});

	test("the integrator only merges", () => {
		expect(integratorBlockReason("teams_merge", { task_id: "T-1" })).toBeNull();
		expect(integratorBlockReason("bash", { command: "git merge x" })).toContain("teams_merge");
	});
});

describe("worker branch creation", () => {
	test("creating a branch is blocked; listing branches is not", () => {
		// Seen in a live run: a worker created `team/files` because its task named that branch.
		expect(bash("git branch team/files")).toContain("create branches");
		expect(bash("cd /teams/wt/p-1/feat-x/w1 && git branch team/files HEAD")).toContain("create branches");
		expect(bash("git branch")).toBeNull();
		expect(bash("git branch -a")).toBeNull();
		expect(bash("git branch --show-current")).toBeNull();
		expect(bash("git branch | cat")).toBeNull();
		expect(bash("git branch 2>/dev/null")).toBeNull();
	});
});

describe("read-only git outside the worktree", () => {
	test("inspection of the main repository and other worktrees is allowed", () => {
		// Seen blocked in a live run: verification workers reading the delivered branch.
		expect(bash("cd /src/repo && git diff --name-status $(git merge-base main teams/feat-x) teams/feat-x")).toBeNull();
		expect(bash("git -C /src/repo merge-tree main teams/feat-x")).toBeNull();
		expect(bash("git -C /src/repo branch -a")).toBeNull();
		expect(bash("git -C /src/repo worktree list")).toBeNull();
		expect(bash("git -C /src/repo stash list")).toBeNull();
		expect(bash("cd /src/repo && git status --porcelain && git ls-tree --name-only teams/feat-x")).toBeNull();
	});

	test("writes there are still blocked", () => {
		expect(bash("git -C /src/repo merge teams/feat-x")).toContain("outside their own worktree");
		expect(bash("git -C /src/repo stash")).toContain("outside their own worktree");
		expect(bash("cd /teams/wt/p-1/feat-x/group && git reset --hard HEAD~1")).toContain("outside their own worktree");
	});
});

describe("every way of switching or creating a branch", () => {
	test("switch is blocked in any form", () => {
		expect(bash("git switch -q main")).toContain("switch branches");
		expect(bash("git switch --create newb")).toContain("switch branches");
	});

	test("checkout that creates or relinks a branch is blocked", () => {
		expect(bash("git checkout -q -b newb")).toContain("create or switch branches");
		expect(bash("git checkout -qb newb")).toContain("create or switch branches");
		expect(bash("git checkout --ignore-other-worktrees teams/feat-x")).toContain("create or switch branches");
	});

	test("branch creation is caught in quiet and tracking forms", () => {
		expect(bash("git branch -q newb")).toContain("create branches");
		expect(bash("git branch --track newb main")).toContain("create branches");
		expect(bash("git branch --no-track newb")).toContain("create branches");
	});

	test("symbolic-ref rewrites a shared ref only when it sets one", () => {
		expect(bash("git symbolic-ref HEAD refs/heads/teams/feat-x")).toContain("rewrite refs");
		expect(bash("git symbolic-ref --short HEAD")).toBeNull();
	});
});

describe("the directory a segment really runs in", () => {
	test("a cd into another team worktree makes the next command foreign", () => {
		expect(bash("cd ../group && git reset --hard HEAD~1")).toContain("outside their own worktree");
		expect(bash("cd ../group && git reset --hard HEAD~1")).toContain("/teams/wt/p-1/feat-x/group");
	});

	test("a -C target is resolved against the worker worktree, not the process cwd", () => {
		expect(bash("git -C ../group merge teams-w/feat-x/w1")).toContain("/teams/wt/p-1/feat-x/group");
	});

	test("a relative bash cwd counts as the directory of every segment", () => {
		expect(bash("git commit -am x", "../group")).toContain("/teams/wt/p-1/feat-x/group");
	});

	test("a ~ in a -C target expands to the home directory", () => {
		expect(bash("git -C ~/teams/wt/p-1/feat-x/group reset --hard", undefined, homeBounds)).toContain(
			`${homedir()}/teams/wt/p-1/feat-x/group`,
		);
	});

	test("cd into the main repository through the common dir is foreign", () => {
		// Seen in a live run: the worker left its worktree by computing the shared git dir.
		expect(bash("cd $(git rev-parse --git-common-dir)/.. && git merge teams-w/feat-x/w1")).toContain("/src/repo");
	});

	test("a loop body and an env prefix still expose the command that runs", () => {
		expect(bash("for f in a b; do git commit -am x; done", "../group")).toContain("outside their own worktree");
		expect(bash("GIT_AUTHOR_NAME=x git commit -am y", "../group")).toContain("outside their own worktree");
	});
});

describe("words inside quotes are arguments, not commands", () => {
	test("a commit message that names a branch, a push or a switch is harmless", () => {
		expect(bash("git commit -m 'add branch coverage'")).toBeNull();
		expect(bash('git commit -m "fix push flow"')).toBeNull();
		expect(bash('git commit -m "docs: switch to bun"')).toBeNull();
		expect(bash("git log --grep push")).toBeNull();
	});

	test("a non-git segment touching protected paths is not a git write there", () => {
		expect(bash("cat /src/repo/README.md && git add -A && git commit -m x")).toBeNull();
		expect(bash("cp /src/repo/docs/a.md docs/ && git add docs && git commit -m x")).toBeNull();
	});
});
