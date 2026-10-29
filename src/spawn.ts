import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TeamsConfig } from "./config";
import type { Herdr, HerdrResult } from "./herdr";
import { groupSeat, labelFor, projectSeat, RANK_GLYPH, resolveProject, ROLE_TITLE, workerSeat, type ProjectIdentity } from "./identity";
import type { AgentRow, GroupRow } from "./registry";
import type { TeamsRuntime } from "./runtime";
import { addWorktree, branchHead, currentBranch } from "./worktree";

export interface SpawnDeps {
	runtime: TeamsRuntime;
	herdr: Herdr;
	home: string;
	config: TeamsConfig;
	env?: Record<string, string | undefined>;
}

export type SpawnOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

const REPO_TAB = `${RANK_GLYPH.project} ${ROLE_TITLE.project}`;

const GROUP_NAME = /^[a-z0-9][a-z0-9-]*$/;

function workerTabLabel(groupName: string): string {
	return `${RANK_GLYPH.worker} workers · ${groupName}`;
}

function shq(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function encodeJoin(fields: Record<string, string | number | undefined>): string {
	return Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== "")
		.map(([key, value]) => `${key}=${String(value).replace(/\s+/g, "_")}`)
		.join(" ");
}

export function decodeJoin(raw: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const token of raw.trim().split(/\s+/)) {
		const index = token.indexOf("=");
		if (index <= 0) continue;
		out[token.slice(0, index)] = token.slice(index + 1);
	}
	return out;
}

export interface LaunchFiles {
	script: string;
	stop: string;
	park: string;
	wake: string;
}

export function launchFiles(home: string, tag: string): LaunchFiles {
	const dir = join(home, "launch");
	return {
		script: join(dir, `${tag}.sh`),
		stop: join(dir, `${tag}.stop`),
		park: join(dir, `${tag}.park`),
		wake: join(dir, `${tag}.wake`),
	};
}

export function seatLaunchFiles(home: string, seat: string): LaunchFiles {
	const tag = launchTag(seat);
	if (!tag) throw new Error(`${seat} has no launcher`);
	return launchFiles(home, tag);
}

export function launchTag(seat: string): string | null {
	if (seat.startsWith("project:")) return `project-${seat.slice("project:".length)}`;
	if (seat.startsWith("group:")) {
		const rest = seat.slice("group:".length);
		const slash = rest.indexOf("/");
		if (slash <= 0) return null;
		return `group-${rest.slice(0, slash)}-${rest.slice(slash + 1)}`;
	}
	if (seat.startsWith("worker:")) return `slot-${seat.slice("worker:".length)}`;
	return null;
}

export function writeLaunchFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

export function launcherScript(input: {
	home: string;
	tag: string;
	cwd: string;
	join: string;
	model: string;
	maxCostUsd?: number;
}): string {
	const files = launchFiles(input.home, input.tag);
	const args = ["omp", "--model", shq(input.model)];
	if (input.maxCostUsd !== undefined && input.maxCostUsd > 0) {
		args.push("--max-cost", String(input.maxCostUsd));
	}
	const run = args.join(" ");
	const lines = [
		"#!/bin/sh",
		`export OMP_TEAMS_HOME=${shq(input.home)}`,
		`export OMP_TEAMS_JOIN=${shq(input.join)}`,
		`export OMP_TEAMS_STOP=${shq(files.stop)}`,
		`export OMP_TEAMS_PARK=${shq(files.park)}`,
		`export OMP_TEAMS_WAKE=${shq(files.wake)}`,
		`cd ${shq(input.cwd)} || exit 1`,
		`rm -f "$OMP_TEAMS_STOP"`,
		"target=''",
		'if [ -e "$OMP_TEAMS_PARK" ]; then',
		'  target=$(cat "$OMP_TEAMS_PARK")',
		'  rm -f "$OMP_TEAMS_PARK" "$OMP_TEAMS_WAKE"',
		"fi",
		"fast=0",
		"while :; do",
		"  started=$(date +%s)",
		'  if [ -n "$target" ]; then',
		`    ${run} --resume "$target"`,
		"    target=''",
		"  else",
		`    ${run}`,
		"  fi",
		'  if [ -e "$OMP_TEAMS_STOP" ]; then rm -f "$OMP_TEAMS_STOP"; echo "omp-teams: member stopped"; break; fi',
		'  if [ -e "$OMP_TEAMS_PARK" ]; then',
		'    target=$(cat "$OMP_TEAMS_PARK")',
		'    echo "omp-teams: parked; waiting for work"',
		'    while [ ! -e "$OMP_TEAMS_WAKE" ]; do sleep 1; done',
		'    rm -f "$OMP_TEAMS_WAKE" "$OMP_TEAMS_PARK"',
		"    fast=0",
		"    continue",
		"  fi",
		'  if [ $(( $(date +%s) - started )) -lt 15 ]; then fast=$((fast + 1)); else fast=0; fi',
		'  if [ "$fast" -ge 3 ]; then echo "omp-teams: omp exited 3 times within 15s; not restarting"; break; fi',
		"  sleep 2",
		"done",
	];
	return `${lines.join("\n")}\n`;
}

function unwrap<T>(result: HerdrResult<T>): T {
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

function writeLauncher(deps: SpawnDeps, seat: string, input: { cwd: string; join: string; model: string; maxCostUsd?: number }): string {
	mkdirSync(join(deps.home, "launch"), { recursive: true });
	const files = seatLaunchFiles(deps.home, seat);
	const tag = launchTag(seat);
	if (!tag) throw new Error(`${seat} has no launcher`);
	writeFileSync(files.script, launcherScript({ home: deps.home, tag, ...input }));
	chmodSync(files.script, 0o755);
	return files.script;
}

function requireRole(actor: AgentRow, expected: "personal" | "project" | "group"): SpawnOutcome<true> {
	if (actor.role === expected) return { ok: true, value: true };
	return { ok: false, error: `${actor.label} is a ${actor.role}; only a ${expected} can do this.` };
}

export interface SpawnedProject {
	project: ProjectIdentity;
	workspaceId: string;
	tabId: string;
	paneId: string;
	script: string;
}

export function spawnProject(
	deps: SpawnDeps,
	actor: AgentRow,
	options: { repoPath: string },
): SpawnOutcome<SpawnedProject> {
	const allowed = requireRole(actor, "personal");
	if (!allowed.ok) return allowed;
	const stopped = deps.runtime.stopReason(actor);
	if (stopped) return { ok: false, error: `nothing is spawned: ${stopped}.` };

	const project = resolveProject(resolve(options.repoPath));
	if (!project) return { ok: false, error: `${options.repoPath} is not inside a git repository` };
	const existing = deps.runtime.registry.holder(`project:${project.id}`);
	if (existing) {
		return { ok: false, error: `${existing.label} already manages ${project.name} (session ${existing.session_id.slice(0, 12)}…)` };
	}

	const script = writeLauncher(deps, projectSeat(project.id), {
		cwd: project.root,
		join: encodeJoin({ role: "project", project: project.id }),
		model: deps.config.models.role.project,
	});

	try {
		const workspaceId = deps.runtime.registry.projectWorkspace(project.id);
		if (workspaceId) {
			const tab = unwrap(deps.herdr.createTab(workspaceId, project.root, REPO_TAB));
			unwrap(deps.herdr.runInPane(tab.paneId, `sh ${shq(script)}`));
			deps.runtime.registry.upsertProject(project.id, project.name, project.root);
			return { ok: true, value: { project, workspaceId, tabId: tab.tabId, paneId: tab.paneId, script } };
		}
		const workspace = unwrap(deps.herdr.createWorkspace(project.root, project.name));
		if (!workspace.workspaceId) return { ok: false, error: "herdr did not return a workspace id" };
		unwrap(deps.herdr.renameTab(workspace.tabId, REPO_TAB));
		unwrap(deps.herdr.renameWorkspace(workspace.workspaceId, project.name));
		unwrap(deps.herdr.runInPane(workspace.paneId, `sh ${shq(script)}`));
		deps.runtime.registry.upsertProject(project.id, project.name, project.root);
		deps.runtime.registry.setProjectWorkspace(project.id, workspace.workspaceId);
		return {
			ok: true,
			value: { project, workspaceId: workspace.workspaceId, tabId: workspace.tabId, paneId: workspace.paneId, script },
		};
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

export interface SpawnedGroup {
	group: GroupRow;
	workspaceId: string;
	tabId: string;
	paneId: string;
	script: string;
}

export function spawnGroup(
	deps: SpawnDeps,
	actor: AgentRow,
	options: { name: string; base?: string; workers?: number },
): SpawnOutcome<SpawnedGroup> {
	const allowed = requireRole(actor, "project");
	if (!allowed.ok) return allowed;
	if (!GROUP_NAME.test(options.name)) {
		return {
			ok: false,
			error: `"${options.name}" cannot name a group: use lowercase letters, digits and "-", for example "cli-docs".`,
		};
	}
	const stopped = deps.runtime.stopReason(actor);
	if (stopped) return { ok: false, error: `nothing is spawned: ${stopped}.` };
	if (!actor.project_id) return { ok: false, error: `${actor.label} has no project id` };
	const projectRoot = deps.runtime.registry.projectRoot(actor.project_id);
	if (!projectRoot) return { ok: false, error: `project root unknown for ${actor.label}` };
	const workspaceId = deps.runtime.registry.projectWorkspace(actor.project_id);
	if (!workspaceId) {
		return { ok: false, error: `${actor.label} has no herdr workspace yet; spawn the project lead with /teams spawn project first` };
	}
	const existing = deps.runtime.registry.holder(`group:${actor.project_id}/${options.name}`);
	if (existing) return { ok: false, error: `${existing.label} already leads group ${options.name}` };

	const worktreePath = resolve(deps.config.worktree_root, actor.project_id, options.name, "group");
	const branch = `teams/${options.name}`;
	const base = options.base ?? currentBranch(projectRoot) ?? "HEAD";
	const worktree = addWorktree(projectRoot, worktreePath, branch, base);
	if (!worktree.ok) return { ok: false, error: worktree.error ?? "worktree creation failed" };
	deps.runtime.registry.upsertGroup({
		projectId: actor.project_id,
		name: options.name,
		worktree: worktreePath,
		branch,
		base,
		head: branchHead(worktreePath),
	});

	const script = writeLauncher(deps, groupSeat(actor.project_id, options.name), {
		cwd: worktreePath,
		join: encodeJoin({ role: "group", project: actor.project_id, group: options.name }),
		model: deps.config.models.role.group,
	});

	try {
		const tab = unwrap(deps.herdr.createTab(workspaceId, worktreePath, labelFor("group", { group: options.name })));
		unwrap(deps.herdr.runInPane(tab.paneId, `sh ${shq(script)}`));
		deps.runtime.registry.setGroupLayout(actor.project_id, options.name, {
			workspaceId,
			tabId: tab.tabId,
			leadPaneId: tab.paneId,
		});
		const group = deps.runtime.registry.group(actor.project_id, options.name);
		if (!group) return { ok: false, error: "group row missing after creation" };
		return { ok: true, value: { group, workspaceId, tabId: tab.tabId, paneId: tab.paneId, script } };
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

export interface RelaunchedSeat {
	paneId: string;
	tabId: string;
	script: string;
}

export function relaunchSeat(deps: SpawnDeps, holder: AgentRow): SpawnOutcome<RelaunchedSeat> {
	if (!launchTag(holder.seat)) return { ok: false, error: `${holder.label} has no launcher of its own.` };
	const files = seatLaunchFiles(deps.home, holder.seat);
	if (!existsSync(files.script)) return { ok: false, error: `the launcher script for ${holder.label} is gone.` };
	const projectId = holder.project_id ?? "";
	const group = holder.group_name ? deps.runtime.registry.group(projectId, holder.group_name) : null;
	const workspaceId = group?.workspace_id ?? deps.runtime.registry.projectWorkspace(projectId);
	if (!workspaceId) return { ok: false, error: `${holder.label} has no herdr workspace to come back to.` };
	const cwd = group?.worktree ?? deps.runtime.registry.projectRoot(projectId) ?? holder.cwd;
	const label = holder.role === "project" ? REPO_TAB : labelFor("group", { group: holder.group_name ?? "group" });
	const tab = deps.herdr.createTab(workspaceId, cwd, label);
	if (!tab.ok) return tab;
	const ran = deps.herdr.runInPane(tab.value.paneId, `sh ${shq(files.script)}`);
	if (!ran.ok) return ran;
	deps.runtime.registry.setPane(holder.id, tab.value.paneId);
	if (holder.role === "group" && holder.project_id && holder.group_name) {
		deps.runtime.registry.setGroupLayout(holder.project_id, holder.group_name, {
			workspaceId,
			tabId: tab.value.tabId,
			leadPaneId: tab.value.paneId,
		});
	}
	return { ok: true, value: { paneId: tab.value.paneId, tabId: tab.value.tabId, script: files.script } };
}

export interface SpawnedWorker {
	slotId: string;
	index: number;
	worktree: string;
	branch: string;
	paneId: string;
	tabId: string;
	script: string;
}

export function spawnWorker(deps: SpawnDeps, actor: AgentRow, options: { count?: number } = {}): SpawnOutcome<SpawnedWorker[]> {
	const allowed = requireRole(actor, "group");
	if (!allowed.ok) return allowed;
	const stopped = deps.runtime.stopReason(actor);
	if (stopped) return { ok: false, error: `nothing is spawned: ${stopped}.` };
	if (!actor.project_id || !actor.group_name) {
		return { ok: false, error: `${actor.label} is not bound to a group` };
	}
	const projectId = actor.project_id;
	const groupName = actor.group_name;
	const group = deps.runtime.registry.group(projectId, groupName);
	if (!group) return { ok: false, error: `group ${groupName} is not registered` };
	const workspaceId = group.workspace_id ?? deps.runtime.registry.projectWorkspace(projectId);
	if (!workspaceId) return { ok: false, error: `no herdr workspace for ${groupName}` };

	const config = deps.config;
	const wanted = Math.max(1, options.count ?? 1);
	const existingSlots = deps.runtime.slots.forGroup(projectId, groupName, "worker");
	const machineWide = deps.runtime.slots.countActiveWorkers();
	if (machineWide + wanted > config.limits.max_workers_total) {
		return {
			ok: false,
			error: `worker cap reached: ${machineWide} active on this machine, ${wanted} requested, limit ${config.limits.max_workers_total}`,
		};
	}
	if (config.auto_integrator && !deps.runtime.slots.integratorFor(projectId, groupName)) {
		const integrator = spawnIntegrator(deps, actor, group);
		if (!integrator.ok) return integrator;
	}

	const spawned: SpawnedWorker[] = [];
	for (let i = 0; i < wanted; i++) {
		const index = existingSlots.length + spawned.length + 1;
		const worktreePath = resolve(config.worktree_root, projectId, groupName, `w${index}`);
		const branch = `teams-w/${groupName}/w${index}`;
		const worktree = addWorktree(resolve(config.worktree_root, projectId, groupName, "group"), worktreePath, branch, group.branch);
		if (!worktree.ok) return { ok: false, error: worktree.error ?? "worker worktree creation failed" };

		const slot = deps.runtime.slots.ensure({
			projectId,
			group: groupName,
			kind: "worker",
			index,
			worktree: worktreePath,
			branch,
		});
		const script = writeLauncher(deps, workerSeat(slot.id), {
			cwd: worktreePath,
			join: encodeJoin({ role: "worker", project: projectId, group: groupName, slot: slot.id }),
			model: config.models.routing.default,
			maxCostUsd: config.limits.worker_max_cost_usd,
		});

		try {
			const placement = placeWorkerPane(deps, {
				workspaceId,
				projectId,
				groupName,
				cwd: worktreePath,
				slots: deps.runtime.slots.forGroup(projectId, groupName, "worker"),
			});
			unwrap(deps.herdr.runInPane(placement.paneId, `sh ${shq(script)}`));
			deps.runtime.slots.bind(slot.id, { paneId: placement.paneId, tabId: placement.tabId });
			unwrap(deps.herdr.renamePane(placement.paneId, labelFor("worker", { group: groupName, index })));
			spawned.push({
				slotId: slot.id,
				index,
				worktree: worktreePath,
				branch,
				paneId: placement.paneId,
				tabId: placement.tabId,
				script,
			});
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}
	return { ok: true, value: spawned };
}

export function spawnIntegrator(deps: SpawnDeps, actor: AgentRow, group: GroupRow): SpawnOutcome<SpawnedWorker> {
	if (!actor.project_id || !actor.group_name) return { ok: false, error: `${actor.label} is not bound to a group` };
	const slot = deps.runtime.slots.ensure({
		projectId: actor.project_id,
		group: actor.group_name,
		kind: "integrator",
		index: 1,
		worktree: group.worktree,
		branch: group.branch,
	});
	const anchor = group.lead_pane_id ?? actor.pane_id;
	if (!anchor) return { ok: false, error: "no group lead pane to place the integrator beside" };
	const script = writeLauncher(deps, workerSeat(slot.id), {
		cwd: group.worktree,
		join: encodeJoin({ role: "worker", project: actor.project_id, group: actor.group_name, slot: slot.id }),
		model: deps.config.models.routing.by_kind.merge ?? deps.config.models.role.integrator,
		maxCostUsd: deps.config.limits.worker_max_cost_usd,
	});
	try {
		const pane = unwrap(deps.herdr.splitPane(anchor, group.worktree, "down"));
		unwrap(deps.herdr.runInPane(pane.paneId, `sh ${shq(script)}`));
		unwrap(deps.herdr.renamePane(pane.paneId, labelFor("worker", { group: actor.group_name, integrator: true })));
		deps.runtime.slots.bind(slot.id, { paneId: pane.paneId, tabId: pane.tabId });
		return {
			ok: true,
			value: {
				slotId: slot.id,
				index: 1,
				worktree: group.worktree,
				branch: group.branch,
				paneId: pane.paneId,
				tabId: pane.tabId,
				script,
			},
		};
	} catch (error) {
		return { ok: false, error: (error as Error).message };
	}
}

function placeWorkerPane(
	deps: SpawnDeps,
	input: {
		workspaceId: string;
		projectId: string;
		groupName: string;
		cwd: string;
		slots: { tab_id: string | null; pane_id: string | null; status: string }[];
	},
): { paneId: string; tabId: string } {
	const perTab = Math.max(1, deps.config.limits.workers_per_tab);
	const byTab = new Map<string, string[]>();
	for (const slot of input.slots) {
		if (!slot.tab_id || !slot.pane_id) continue;
		const panes = byTab.get(slot.tab_id) ?? [];
		panes.push(slot.pane_id);
		byTab.set(slot.tab_id, panes);
	}
	const roomy = [...byTab.entries()].find(([, panes]) => panes.length < perTab);
	if (roomy) {
		const lastPane = roomy[1][roomy[1].length - 1];
		if (lastPane) {
			const split = unwrap(deps.herdr.splitPane(lastPane, input.cwd, "right"));
			return { paneId: split.paneId, tabId: split.tabId };
		}
	}
	const base = workerTabLabel(input.groupName);
	const label = byTab.size === 0 ? base : `${base} (${byTab.size + 1})`;
	const tab = unwrap(deps.herdr.createTab(input.workspaceId, input.cwd, label));
	return { paneId: tab.paneId, tabId: tab.tabId };
}
