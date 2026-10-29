import { readdirSync, statSync, type Dirent } from "node:fs";
import { basename, join, resolve } from "node:path";
import { expandHome, resolveProject, type ProjectIdentity } from "./identity";

export interface RepoSearch {
	registered: ProjectIdentity[];
	roots: string[];
	depth: number;
}

export type RepoLookup = { ok: true; project: ProjectIdentity } | { ok: false; error: string };

interface RepoCandidate {
	name: string;
	root: string;
	registered: ProjectIdentity | null;
}

function gitMarker(dir: string): "directory" | "file" | null {
	try {
		return statSync(join(dir, ".git")).isDirectory() ? "directory" : "file";
	} catch {
		return null;
	}
}

function existingDir(path: string): string | null {
	const absolute = resolve(expandHome(path));
	try {
		return statSync(absolute).isDirectory() ? absolute : null;
	} catch {
		return null;
	}
}

function childDirs(dir: string): Dirent[] {
	try {
		return readdirSync(dir, { withFileTypes: true }).filter(
			(entry) => entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
		);
	} catch {
		return [];
	}
}

function scanRoot(root: string, depth: number, found: RepoCandidate[]): void {
	const queue: { dir: string; level: number }[] = [{ dir: root, level: 0 }];
	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		if (item.level > depth) continue;
		const marker = gitMarker(item.dir);
		if (marker) {
			if (marker === "directory") found.push({ name: basename(item.dir), root: item.dir, registered: null });
			continue;
		}
		if (item.level >= depth) continue;
		for (const entry of childDirs(item.dir)) {
			queue.push({ dir: join(item.dir, entry.name), level: item.level + 1 });
		}
	}
}

function collectCandidates(search: RepoSearch): RepoCandidate[] {
	const byRoot = new Map<string, RepoCandidate>();
	for (const project of search.registered) {
		byRoot.set(resolve(project.root), { name: project.name, root: project.root, registered: project });
	}
	for (const root of search.roots) {
		const absolute = existingDir(root);
		if (!absolute) continue;
		const found: RepoCandidate[] = [];
		scanRoot(absolute, search.depth, found);
		for (const candidate of found) {
			const key = resolve(candidate.root);
			if (!byRoot.has(key)) byRoot.set(key, candidate);
		}
	}
	return [...byRoot.values()];
}

function resolveCandidate(candidate: RepoCandidate): RepoLookup {
	if (candidate.registered) return { ok: true, project: candidate.registered };
	const project = resolveProject(candidate.root);
	if (!project) return { ok: false, error: `${candidate.root} is not inside a git repository.` };
	return { ok: true, project };
}

export function findRepository(query: string, search: RepoSearch): RepoLookup {
	const trimmed = query.trim();
	if (!trimmed) return { ok: false, error: "name a repository." };

	const pathLike =
		trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.startsWith(".") || trimmed.includes("/");
	if (pathLike) {
		const project = resolveProject(resolve(expandHome(trimmed)));
		if (!project) return { ok: false, error: `${trimmed} is not inside a git repository.` };
		return { ok: true, project };
	}

	const entries = collectCandidates(search).map((candidate) => ({
		candidate,
		key: candidate.name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""),
	}));
	const queryKey = trimmed.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

	const exact = entries.filter((entry) => entry.key === queryKey);
	if (exact.length === 1) {
		const only = exact[0];
		if (only) return resolveCandidate(only.candidate);
	}
	if (exact.length > 1) {
		const list = exact.map((entry) => `${entry.candidate.name} (${entry.candidate.root})`).join("; ");
		return { ok: false, error: `"${trimmed}" matches several repositories: ${list}.` };
	}

	const close = entries.filter(
		(entry) => entry.key.includes(queryKey) || queryKey.includes(entry.key),
	);
	if (close.length > 0) {
		const list = close.map((entry) => `${entry.candidate.name} (${entry.candidate.root})`).join("; ");
		return { ok: false, error: `no repository is named "${trimmed}". Close matches: ${list}.` };
	}
	return {
		ok: false,
		error: `no repository named "${trimmed}" was found under ${search.roots.join(", ")} (depth ${search.depth}).`,
	};
}
