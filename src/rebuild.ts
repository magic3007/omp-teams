import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Herdr } from "./herdr";
import { groupSeat, labelFor, projectSeat, RANK_GLYPH, ROLE_TITLE, workerSeat } from "./identity";
import type { TeamsRuntime } from "./runtime";
import type { SlotRow } from "./slots";
import { ANALYST_TAB, launchCommand, seatLaunchFiles, workerTabLabel } from "./spawn";

export interface RebuildDeps {
	runtime: TeamsRuntime;
	herdr: Herdr;
	home: string;
}

interface PaneInfo {
	pane_id: string;
	tab_id?: string;
	workspace_id?: string;
}

function listPanes(herdr: Herdr): PaneInfo[] {
	const result = herdr.listPanes();
	return result.ok ? (result.value as unknown as PaneInfo[]) : [];
}

function paneExists(panes: PaneInfo[], paneId: string | null): boolean {
	return paneId !== null && panes.some((pane) => pane.pane_id === paneId);
}

function tabExists(panes: PaneInfo[], tabId: string | null): boolean {
	return tabId !== null && panes.some((pane) => pane.tab_id === tabId);
}

function relaunch(deps: RebuildDeps, paneId: string, seat: string): boolean {
	const script = seatLaunchFiles(deps.home, seat).script;
	if (!existsSync(script)) return false;
	const result = deps.herdr.runInPane(paneId, launchCommand(script));
	return result.ok;
}

export interface RebuildResult {
	workspacesCreated: number;
	tabsCreated: number;
	panesCreated: number;
	relaunched: string[];
	missing: string[];
}

export function rebuildMachine(deps: RebuildDeps): RebuildResult {
	const { runtime, herdr } = deps;
	const result: RebuildResult = { workspacesCreated: 0, tabsCreated: 0, panesCreated: 0, relaunched: [], missing: [] };
	let panes = listPanes(herdr);
	const tabs = new Map<string, string>();

	const ensureWorkspace = (projectId: string, root: string, name: string): string | null => {
		const existing = runtime.registry.projectWorkspace(projectId);
		const alive = existing && panes.some((pane) => pane.workspace_id === existing);
		if (existing && alive) return existing;
		const created = herdr.createWorkspace(root, name);
		if (!created.ok || !created.value.workspaceId) {
			result.missing.push(`workspace for ${name}: ${created.ok ? "no id" : created.error}`);
			return null;
		}
		runtime.registry.setProjectWorkspace(projectId, created.value.workspaceId);
		result.workspacesCreated++;
		panes = listPanes(herdr);
		return created.value.workspaceId;
	};

	const ensureTab = (workspaceId: string, cwd: string, label: string, existingTab: string | null): string | null => {
		if (tabExists(panes, existingTab)) return existingTab;
		const cached = tabs.get(label);
		if (cached && tabExists(panes, cached)) return cached;
		const created = herdr.createTab(workspaceId, cwd, label);
		if (!created.ok || !created.value.tabId) {
			result.missing.push(`tab ${label}: ${created.ok ? "no id" : created.error}`);
			return null;
		}
		tabs.set(label, created.value.tabId);
		result.tabsCreated++;
		panes = listPanes(herdr);
		return created.value.tabId;
	};

	const ensurePane = (tabId: string, cwd: string, anchor: string | null): string | null => {
		if (paneExists(panes, anchor)) return anchor;
		const created = herdr.splitPane(panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? "", cwd, "right");
		if (!created.ok || !created.value.paneId) {
			result.missing.push(`pane in ${tabId}: ${created.ok ? "no id" : created.error}`);
			return null;
		}
		result.panesCreated++;
		panes = listPanes(herdr);
		return created.value.paneId;
	};

	const projects = runtime.registry.allProjects();
	for (const project of projects) {
		const lead = runtime.registry.holder(`project:${project.id}`);
		if (!lead) continue;
		const workspaceId = ensureWorkspace(project.id, project.root, project.name);
		if (!workspaceId) continue;
		if (paneExists(panes, lead.pane_id)) continue;
		const tabId = ensureTab(workspaceId, project.root, `${RANK_GLYPH.project} ${ROLE_TITLE.project}`, null);
		if (!tabId) continue;
		const paneId = panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null;
		if (!paneId) {
			result.missing.push(`repo leader pane for ${project.name}`);
			continue;
		}
		if (relaunch(deps, paneId, projectSeat(project.id))) {
			runtime.registry.setPane(lead.id, paneId);
			result.relaunched.push(lead.label);
		} else {
			result.missing.push(`launcher for ${lead.label}`);
		}
	}

	const groups = runtime.registry.allGroups();
	for (const group of groups) {
		const lead = runtime.registry.holder(`group:${group.project_id}/${group.name}`);
		if (!lead || paneExists(panes, lead.pane_id)) continue;
		const workspaceId = ensureWorkspace(group.project_id, runtime.registry.projectRoot(group.project_id) ?? group.worktree, group.project_id);
		if (!workspaceId) continue;
		const tabId = ensureTab(
			workspaceId,
			group.worktree,
			labelFor("group", { group: group.name }),
			group.tab_id,
		);
		if (!tabId) continue;
		runtime.registry.setGroupLayout(group.project_id, group.name, { workspaceId, tabId });
		const paneId = panes.find((pane) => pane.tab_id === tabId)?.pane_id ?? null;
		if (!paneId) {
			result.missing.push(`group lead pane for ${group.name}`);
			continue;
		}
		if (relaunch(deps, paneId, groupSeat(group.project_id, group.name))) {
			runtime.registry.setPane(lead.id, paneId);
			result.relaunched.push(lead.label);
		} else {
			result.missing.push(`launcher for ${lead.label}`);
		}
	}

	const slots = runtime.slots.all();
	for (const slot of slots) {
		if (slot.status === "retired") continue;
		if (paneExists(panes, slot.pane_id)) continue;
		const workspaceId = slot.project_id
			? ((slot.group_name ? runtime.registry.group(slot.project_id, slot.group_name)?.workspace_id : null) ??
				runtime.registry.projectWorkspace(slot.project_id))
			: null;
		if (!workspaceId) {
			result.missing.push(`workspace for slot ${slot.id}`);
			continue;
		}
		const tabId = ensureTab(workspaceId, slot.worktree, slotTabLabel(slot), slot.tab_id);
		if (!tabId) continue;
		const paneId = ensurePane(tabId, slot.worktree, null);
		if (!paneId) continue;
		if (relaunch(deps, paneId, workerSeat(slot.id))) {
			runtime.slots.bind(slot.id, { paneId, tabId });
			result.relaunched.push(labelFor("worker", { group: slot.group_name ?? undefined, index: slot.index_no, slot: slot.kind }));
		} else {
			result.missing.push(`launcher for slot ${slot.id}`);
		}
	}

	return result;
}

function slotTabLabel(slot: SlotRow): string {
	switch (slot.kind) {
		case "analyst":
			return ANALYST_TAB;
		case "integrator":
			return labelFor("worker", { group: slot.group_name ?? undefined, slot: "integrator" });
		case "worker":
			return workerTabLabel(slot.group_name ?? "");
	}
}

export function describeRebuild(result: RebuildResult): string {
	const parts: string[] = [];
	if (result.workspacesCreated > 0) parts.push(`${result.workspacesCreated} workspace(s) recreated`);
	if (result.tabsCreated > 0) parts.push(`${result.tabsCreated} tab(s) recreated`);
	if (result.panesCreated > 0) parts.push(`${result.panesCreated} pane(s) recreated`);
	if (result.relaunched.length > 0) parts.push(`relaunched: ${result.relaunched.join(", ")}`);
	if (result.missing.length > 0) parts.push(`needs a human: ${result.missing.join("; ")}`);
	return parts.length === 0 ? "every pane was already there." : `${parts.join("; ")}.`;
}
