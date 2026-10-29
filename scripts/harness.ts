import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Herdr, herdrAvailable, type HerdrPane } from "../src/herdr";

export interface Harness {
	root: string;
	teamsHome: string;
	repo: string;
	herdr: Herdr;
	createdWorkspaces: string[];
	failures: string[];
	tag: string;
}

export function createHarness(name: string, config: string[]): Harness {
	if (!herdrAvailable()) {
		console.error("this harness must run inside a herdr pane (HERDR_ENV=1)");
		process.exit(2);
	}
	const root = mkdtempSync(join(tmpdir(), `omp-teams-${name}-`));
	const teamsHome = join(root, "teams");
	const repo = join(root, "repo");
	mkdirSync(teamsHome, { recursive: true });
	writeFileSync(join(teamsHome, "config.yml"), `${config.join("\n")}\n`);
	sh(root, ["git", "init", "-q", "-b", "main", repo]);
	sh(repo, ["git", "config", "user.email", "e2e@example.com"]);
	sh(repo, ["git", "config", "user.name", "e2e"]);
	writeFileSync(join(repo, "README.md"), "# repo\n");
	sh(repo, ["git", "add", "."]);
	sh(repo, ["git", "commit", "-qm", "init"]);
	console.log(`root: ${root}`);
	return {
		root,
		teamsHome,
		repo,
		herdr: new Herdr(),
		createdWorkspaces: [],
		failures: [],
		tag: `omp-teams-${name}-${Date.now().toString(36)}`,
	};
}

export function sh(cwd: string, args: string[]): string {
	const proc = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`${args.join(" ")}: ${proc.stderr.toString()}`);
	return proc.stdout.toString().trim();
}

export function check(h: Harness, name: string, ok: boolean, detail = ""): void {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) h.failures.push(name);
}

function isTransient(message: string): boolean {
	return message.includes("locked") || message.includes("busy");
}

export function queryOne<T>(h: Harness, sql: string, params: (string | number | null)[] = []): T | null {
	for (let attempt = 0; ; attempt++) {
		const handle = new Database(join(h.teamsHome, "teams.db"));
		try {
			return (handle.query(sql).get(...params) as T | null) ?? null;
		} catch (error) {
			const message = (error as Error).message;
			if (message.includes("no such table")) return null;
			if (!isTransient(message) || attempt >= 40) throw error;
		} finally {
			handle.close();
		}
		Bun.sleepSync(100);
	}
}

export function queryAll<T>(h: Harness, sql: string, params: (string | number | null)[] = []): T[] {
	for (let attempt = 0; ; attempt++) {
		const handle = new Database(join(h.teamsHome, "teams.db"));
		try {
			return handle.query(sql).all(...params) as T[];
		} catch (error) {
			const message = (error as Error).message;
			if (message.includes("no such table")) return [];
			if (!isTransient(message) || attempt >= 40) throw error;
		} finally {
			handle.close();
		}
		Bun.sleepSync(100);
	}
}

export function aliveCount(h: Harness, role: string): number {
	return queryOne<{ n: number }>(h, "SELECT COUNT(*) AS n FROM agents WHERE role = ? AND status = 'alive'", [role])?.n ?? 0;
}

export async function waitFor(predicate: () => boolean, timeoutMs: number, label: string): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return true;
		await Bun.sleep(250);
	}
	console.log(`  (timeout: ${label})`);
	return false;
}

export function panes(h: Harness): HerdrPane[] {
	const result = h.herdr.listPanes();
	return result.ok ? result.value : [];
}

export function run(h: Harness, paneId: string, command: string): void {
	const result = h.herdr.runInPane(paneId, command);
	if (!result.ok) throw new Error(result.error);
}

function agentStatus(paneId: string): string | null {
	const proc = Bun.spawnSync(["herdr", "pane", "get", paneId], { stdout: "pipe", stderr: "pipe" });
	const text = proc.stdout.toString();
	if (!text) return null;
	const parsed = JSON.parse(text) as { result?: { pane?: { agent_status?: string } } };
	return parsed.result?.pane?.agent_status ?? null;
}

export async function submit(h: Harness, paneId: string, text: string, taken: () => boolean = () => false): Promise<boolean> {
	run(h, paneId, text);
	for (let attempt = 0; attempt < 3; attempt++) {
		if (await waitFor(() => taken() || agentStatus(paneId) === "working", 20_000, "prompt submitted")) return true;
		Bun.spawnSync(["herdr", "pane", "send-keys", paneId, "enter"], { stdout: "pipe", stderr: "pipe" });
	}
	return taken() || agentStatus(paneId) === "working";
}

export function paneTail(paneId: string, lines = 25): string {
	const result = Bun.spawnSync(
		["herdr", "pane", "read", paneId, "--source", "recent-unwrapped", "--lines", String(lines)],
		{ stdout: "pipe", stderr: "pipe" },
	);
	return result.stdout.toString().trim();
}

export function lastLines(paneId: string, count: number): string {
	return paneTail(paneId, count * 2)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.slice(-count)
		.join(" ⏎ ");
}

export function launchPersonal(h: Harness): string {
	const workspace = h.herdr.createWorkspace(h.root, `★★★ ${h.tag}`);
	if (!workspace.ok) throw new Error(workspace.error);
	if (!workspace.value.workspaceId) throw new Error("no workspace id");
	h.createdWorkspaces.push(workspace.value.workspaceId);
	const launcher = join(h.root, "personal.sh");
	writeFileSync(
		launcher,
		[
			"#!/bin/sh",
			`export OMP_TEAMS_HOME='${h.teamsHome}'`,
			"export OMP_TEAMS_JOIN='role=personal'",
			`cd '${h.root}'`,
			"exec omp --model deepseek/deepseek-flash",
			"",
		].join("\n"),
	);
	chmodSync(launcher, 0o755);
	run(h, workspace.value.paneId, `sh ${launcher}`);
	return workspace.value.paneId;
}

export function cleanup(h: Harness): void {
	for (const row of queryAll<{ workspace_id: string }>(h, "SELECT workspace_id FROM projects WHERE workspace_id IS NOT NULL")) {
		if (!h.createdWorkspaces.includes(row.workspace_id)) h.createdWorkspaces.push(row.workspace_id);
	}
	if (process.env.KEEP === "1") {
		console.log(`kept: ${h.root} (workspaces: ${h.createdWorkspaces.join(", ")})`);
		return;
	}
	for (const workspaceId of h.createdWorkspaces) h.herdr.closeWorkspace(workspaceId);
	rmSync(h.root, { recursive: true, force: true });
}

export function finish(h: Harness, label: string): never {
	cleanup(h);
	if (h.failures.length > 0) {
		console.log(`\n${h.failures.length} check(s) failed`);
		process.exit(1);
	}
	console.log(`\nall ${label} checks passed`);
	process.exit(0);
}

export async function bringUpGroup(
	h: Harness,
	group: string,
): Promise<{ personalPane: string; projectPane: string; groupPane: string; workspaceId: string } | null> {
	const personalPane = launchPersonal(h);
	const personalUp = await waitFor(() => aliveCount(h, "personal") === 1, 120_000, "personal registered");
	check(h, "personal manager self-registers", personalUp);
	if (!personalUp) return null;

	run(h, personalPane, `/teams spawn project --repo ${h.repo}`);
	const projectUp = await waitFor(() => aliveCount(h, "project") === 1, 180_000, "project lead registered");
	check(h, "project lead comes up", projectUp, projectUp ? "" : lastLines(personalPane, 4));
	if (!projectUp) return null;
	await waitFor(
		() => Boolean(queryOne<{ workspace_id: string | null }>(h, "SELECT workspace_id FROM projects")?.workspace_id),
		30_000,
		"project workspace recorded",
	);
	const workspaceId = queryOne<{ workspace_id: string }>(h, "SELECT workspace_id FROM projects")?.workspace_id ?? "";
	if (workspaceId) h.createdWorkspaces.push(workspaceId);
	const projectPane = queryOne<{ pane_id: string }>(h, "SELECT pane_id FROM agents WHERE role = 'project' AND status = 'alive'")?.pane_id ?? "";

	run(h, projectPane, `/teams spawn group ${group}`);
	const groupUp = await waitFor(() => aliveCount(h, "group") === 1, 180_000, "group lead registered");
	check(h, "group lead comes up", groupUp, groupUp ? "" : lastLines(projectPane, 4));
	if (!groupUp) return null;
	const groupPane = queryOne<{ pane_id: string }>(h, "SELECT pane_id FROM agents WHERE role = 'group' AND status = 'alive'")?.pane_id ?? "";
	return { personalPane, projectPane, groupPane, workspaceId };
}
