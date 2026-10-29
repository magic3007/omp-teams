import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProject } from "../src/identity";
import { findRepository, type RepoLookup, type RepoSearch } from "../src/repos";

const root = realpathSync(mkdtempSync(join(tmpdir(), "omp-teams-repos-")));
const outside = realpathSync(mkdtempSync(join(tmpdir(), "omp-teams-outside-")));

function initRepo(path: string): string {
	mkdirSync(path, { recursive: true });
	const proc = Bun.spawnSync(["git", "init", "-q", path]);
	if (proc.exitCode !== 0) throw new Error(`git init failed for ${path}`);
	return path;
}

initRepo(join(root, "code", "omp-teams"));
mkdirSync(join(root, "code", "omp-teams", "src"), { recursive: true });
writeFileSync(join(root, "code", "omp-teams", "src", "index.ts"), "export {};\n");
initRepo(join(root, "one", "max-code"));
initRepo(join(root, "two", "max-code"));
initRepo(join(root, "levels", "a", "b", "level4-repo"));
initRepo(join(root, "levels", "a", "b", "c", "level5-repo"));
initRepo(join(root, ".hidden", "secret-repo"));
initRepo(join(root, "node_modules", "pkg-repo"));
initRepo(join(root, "outer-repo"));
initRepo(join(root, "outer-repo", "inner-repo"));
mkdirSync(join(root, "gitfile-dir"), { recursive: true });
writeFileSync(join(root, "gitfile-dir", ".git"), "gitdir: /nowhere/.git/worktrees/x\n");
initRepo(join(outside, "outside-repo"));

const search: RepoSearch = { registered: [], roots: [root], depth: 4 };

function failure(result: RepoLookup): string {
	if (result.ok) throw new Error(`expected a failed lookup, got ${result.project.root}`);
	return result.error;
}

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
	rmSync(outside, { recursive: true, force: true });
});

describe("repository lookup by name", () => {
	test("a name that differs only in case and punctuation matches one repository", () => {
		const result = findRepository("omp teams", search);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.project.name).toBe("omp-teams");
		expect(result.project.root).toBe(join(root, "code", "omp-teams"));
	});

	test("two repositories with the same name are reported, never picked", () => {
		const error = failure(findRepository("max-code", search));
		expect(error).toContain('"max-code" matches several repositories');
		expect(error).toContain(join(root, "one", "max-code"));
		expect(error).toContain(join(root, "two", "max-code"));
	});

	test("a partial name is never selected and only listed as a close match", () => {
		const error = failure(findRepository("teams", search));
		expect(error).toContain('no repository is named "teams"');
		expect(error).toContain("Close matches:");
		expect(error).toContain(`omp-teams (${join(root, "code", "omp-teams")})`);
	});

	test("a registered repository outside every root is found by name", () => {
		const project = resolveProject(join(outside, "outside-repo"));
		if (!project) throw new Error("unreachable");
		const withRegistered: RepoSearch = { registered: [project], roots: [root], depth: 4 };
		const result = findRepository("outside-repo", withRegistered);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.project).toEqual(project);
	});
});

describe("repository lookup by path", () => {
	test("a path inside a repository resolves to the repository root", () => {
		const result = findRepository(join(root, "code", "omp-teams", "src"), search);
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("unreachable");
		expect(result.project.root).toBe(join(root, "code", "omp-teams"));
	});

	test("a path outside any repository is an error", () => {
		const error = failure(findRepository(join(root, "code"), search));
		expect(error).toBe(`${join(root, "code")} is not inside a git repository.`);
	});

	test("an empty query asks for a name", () => {
		expect(failure(findRepository("   ", search))).toBe("name a repository.");
	});
});

describe("repository scanning", () => {
	test("a repository at the depth limit is found and one past it is not", () => {
		const found = findRepository("level4-repo", search);
		expect(found.ok).toBe(true);
		if (!found.ok) throw new Error("unreachable");
		expect(found.project.root).toBe(join(root, "levels", "a", "b", "level4-repo"));

		const missing = failure(findRepository("level5-repo", search));
		expect(missing).toContain('no repository named "level5-repo" was found');
		expect(missing).toContain("(depth 4)");
	});

	test("hidden, vendored and nested repositories are not found", () => {
		expect(failure(findRepository("secret-repo", search))).toContain('no repository named "secret-repo" was found');
		expect(failure(findRepository("pkg-repo", search))).toContain('no repository named "pkg-repo" was found');
		expect(failure(findRepository("inner-repo", search))).toContain('no repository named "inner-repo" was found');
	});

	test("a directory holding a .git file is not a repository candidate", () => {
		const error = failure(findRepository("gitfile-dir", search));
		expect(error).toContain('no repository named "gitfile-dir" was found');
	});
});
