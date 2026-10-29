import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import type { TaskDifficulty, TaskKind } from "./config";
import type { TeamsHost } from "./host";
import { git, PARKED_GLYPH, resolveProject, type Role } from "./identity";
import { type SpawnDeps, spawnGroup, spawnProject, spawnWorker } from "./spawn";
import { awaitSeat, assignWork, queueWork, routeDeps } from "./route";
import { describeRebuild, rebuildMachine } from "./rebuild";
import { formatUsd } from "./guard";
import { sinceFromHours, writeAudit, writeDailyReport } from "./report";
import { buildTeamTree, showTreeOverlay, treeText } from "./tree";

const USAGE = [
	"/teams personal [--force]            register this session as the machine-wide manager",
	"/teams project [--force]             register this session as the manager of this repository",
	"/teams group <name> [--worktree <path>] [--force]   register a group lead",
	"/teams join <group>                  register this session as a worker of an existing group",
	"/teams spawn project --repo <path>   spawn a project lead in its own herdr workspace",
	"/teams spawn group <name>            spawn a group lead",
	"/teams spawn worker [--count N]      spawn N workers into this group (the integrator comes with the first)",
	"/teams assign <repo|group|worker|queue> <kind> <difficulty> <task>   hand work down one level (a missing leader or worker is started)",
	"/teams queue                         show this group's task list",
	"/teams pause <group> | resume <group>   stop or resume claiming in a group",
	"/teams retire <worker>               stop a worker after its current task (group lead)",
	"/teams accept-head <group>           accept a group branch that moved outside the integrator; merges resume",
	"/teams takeover | release            drive this worker pane by hand / give it back",
	"/teams tree [--all] [--text] [--paths]   the members below you with their omp session ids (--all: whole machine)",
	"/teams status | progress [--fresh]    membership, subordinate reports (--fresh asks them for one ephemeral status turn)",
	"/teams report <text>                 report progress to your manager",
	"/teams digest                        write today's report (~/.omp/teams/reports) and notify; managers also have teams_write_report",
	"/teams audit [--hours N]             export the last N hours of tasks, mail, events and spend as JSON",
	"/teams halt [reason]                 stop all new work everywhere; running tasks finish",
	"/teams resume                        lift the halt (no group argument) and rebuild missing panes",
	"/teams bootstrap --yes               build personal -> repo leader -> group leader -> workers in one step",
	"/teams leave                         leave the team (the launcher does not restart you)",
	"--force on a registration takes the seat from a live holder (handoff); the old holder stops acting.",
].join("\n");

interface ParsedArgs {
	positional: string[];
	flags: Record<string, string | true>;
}

export function parseArgs(raw: string): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | true> = {};
	const tokens = raw.trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i] as string;
		if (!token.startsWith("--")) {
			positional.push(token);
			continue;
		}
		const name = token.slice(2);
		const next = tokens[i + 1];
		if (next && !next.startsWith("--")) {
			flags[name] = next;
			i++;
		} else {
			flags[name] = true;
		}
	}
	return { positional, flags };
}

export function expandPath(path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(path);
}

function isInside(parent: string, child: string): boolean {
	const a = resolve(parent);
	const b = resolve(child);
	return b === a || b.startsWith(a.endsWith(sep) ? a : `${a}${sep}`);
}

function sessionInfo(ctx: ExtensionCommandContext): { sessionId: string; sessionFile: string | null } {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? null,
	};
}

export function registerTeamsCommands(
	pi: ExtensionAPI,
	host: TeamsHost,
	spawnDeps: () => SpawnDeps | null,
): void {
	pi.registerCommand("teams", {
		description: "Team membership, spawning, tasks and control (run /teams for the full list)",
		getArgumentCompletions: (prefix) =>
			[
				"personal",
				"project",
				"group",
				"join",
				"spawn",
				"assign",
				"queue",
				"pause",
				"resume",
				"retire",
				"accept-head",
				"takeover",
				"release",
				"status",
				"tree",
				"report",
				"progress",
				"digest",
				"audit",
				"halt",
				"bootstrap",
				"leave",
			]
				.filter((name) => name.startsWith(prefix))
				.map((name) => ({ label: name, value: name })),
		handler: async (rawArgs, ctx) => {
			const { positional, flags } = parseArgs(rawArgs ?? "");
			const sub = positional[0] ?? "";
			const { runtime } = host;

			switch (sub) {
				case "":
					host.notify(USAGE, "info");
					return;
				case "personal": {
					const existing = runtime.registry.bySeat("personal");
					const info = sessionInfo(ctx);
					if (existing && existing.session_id !== info.sessionId && flags.force !== true) {
						host.notify(
							`personal manager already exists: ${existing.label} in pane ${existing.pane_id ?? "-"} (session ${existing.session_id.slice(0, 12)}…). Run /teams leave there, or /teams personal --force to take over.`,
							"error",
						);
						return;
					}
					const result = runtime.register({
						role: "personal",
						cwd: ctx.cwd,
						sessionId: info.sessionId,
						sessionFile: info.sessionFile,
						paneId: process.env.HERDR_PANE_ID ?? null,
						force: flags.force === true,
					});
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					await finishRegistration(host, ctx, result.agent.role, result.agent.label);
					return;
				}
				case "project": {
					const project = resolveProject(ctx.cwd);
					if (!project) {
						host.notify("this directory is not inside a git repository; no project to register.", "error");
						return;
					}
					const info = sessionInfo(ctx);
					const result = runtime.register(
						{
							role: "project",
							cwd: ctx.cwd,
							sessionId: info.sessionId,
							sessionFile: info.sessionFile,
							paneId: process.env.HERDR_PANE_ID ?? null,
							projectId: project.id,
							projectName: project.name,
							force: flags.force === true,
						},
						{ project },
					);
					if (!result.ok) {
						host.notify(`${result.error}${flags.force === true ? "" : " (use --force to take the seat over)"}`, "error");
						return;
					}
					await finishRegistration(host, ctx, result.agent.role, result.agent.label);
					return;
				}
				case "group": {
					const name = positional[1];
					if (!name) {
						host.notify("/teams group <name> [--new-worktree | --worktree <path>]", "error");
						return;
					}
					const project = resolveProject(ctx.cwd);
					if (!project) {
						host.notify("this directory is not inside a git repository; no project for this group.", "error");
						return;
					}
					const existingGroup = runtime.registry.group(project.id, name);
					const config = runtime.configFor(project.root);

					let worktree: string | null = null;
					let branch = `teams/${name}`;
					const base = existingGroup?.base ?? git(project.root, ["symbolic-ref", "--short", "HEAD"]) ?? "HEAD";

					if (typeof flags.worktree === "string") {
						worktree = expandPath(flags.worktree);
						if (!existsSync(worktree) || !statSync(worktree).isDirectory()) {
							host.notify(`--worktree ${worktree} does not exist`, "error");
							return;
						}
						branch = git(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? branch;
					} else if (existingGroup) {
						worktree = existingGroup.worktree;
						branch = existingGroup.branch;
					} else {
						const target = resolve(config.worktree_root, project.id, name, "group");
						if (!existsSync(target)) {
							const added = git(project.root, ["worktree", "add", target, "-b", branch, base]);
							if (added === null) {
								host.notify(
									`failed to create worktree ${target} (branch ${branch} from ${base}). Check that the branch does not already exist.`,
									"error",
								);
								return;
							}
						}
						worktree = target;
					}

					const info = sessionInfo(ctx);
					const result = runtime.register(
						{
							role: "group",
							cwd: ctx.cwd,
							sessionId: info.sessionId,
							sessionFile: info.sessionFile,
							paneId: process.env.HERDR_PANE_ID ?? null,
							projectId: project.id,
							projectName: project.name,
							group: name,
							force: flags.force === true,
						},
						{ project, group: { worktree, branch, base } },
					);
					if (!result.ok) {
						host.notify(`${result.error}${flags.force === true ? "" : " (use --force to take the seat over)"}`, "error");
						return;
					}
					await finishRegistration(host, ctx, result.agent.role, result.agent.label);
					host.notify(`group ${name} worktree: ${worktree} (branch ${branch})`, "info");
					return;
				}
				case "join": {
					const name = positional[1];
					if (!name) {
						host.notify("/teams join <group>", "error");
						return;
					}
					const project = resolveProject(ctx.cwd);
					if (!project) {
						host.notify("this directory is not inside a git repository; no group to join.", "error");
						return;
					}
					const group = runtime.registry.group(project.id, name);
					if (!group) {
						host.notify(
							`group "${name}" is not registered in ${project.name}. Run /teams group ${name} in the repository first.`,
							"error",
						);
						return;
					}
					if (!isInside(group.worktree, ctx.cwd)) {
						host.notify(
							`this session is in ${ctx.cwd}, outside the group worktree ${group.worktree}. Start a session in the worktree, then run /teams join ${name}.`,
							"error",
						);
						return;
					}
					const info = sessionInfo(ctx);
					const result = runtime.register(
						{
							role: "worker",
							cwd: ctx.cwd,
							sessionId: info.sessionId,
							sessionFile: info.sessionFile,
							paneId: process.env.HERDR_PANE_ID ?? null,
							projectId: project.id,
							projectName: project.name,
							group: name,
						},
						{ project },
					);
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					await finishRegistration(host, ctx, result.agent.role, result.agent.label);
					return;
				}
				case "spawn": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					const deps = spawnDeps();
					if (!deps) {
						host.notify("herdr is not available here; spawning needs to run inside a herdr pane.", "error");
						return;
					}
					const target = positional[1];
					const count = typeof flags.count === "string" ? Number.parseInt(flags.count, 10) : undefined;
					if (target === "project") {
						const repo = typeof flags.repo === "string" ? flags.repo : ctx.cwd;
						const spawned = spawnProject(deps, me, { repoPath: repo });
						if (!spawned.ok) {
							host.notify(spawned.error, "error");
							return;
						}
						host.notify(
							`project lead for ${spawned.value.project.name} starting in workspace ${spawned.value.workspaceId} (pane ${spawned.value.paneId})`,
							"info",
						);
						return;
					}
					if (target === "group") {
						const name = positional[2];
						if (!name) {
							host.notify("/teams spawn group <name>", "error");
							return;
						}
						const spawned = spawnGroup(deps, me, { name });
						if (!spawned.ok) {
							host.notify(spawned.error, "error");
							return;
						}
						host.notify(`group lead ${name} starting in tab ${spawned.value.tabId}`, "info");
						return;
					}
					if (target === "worker") {
						const requestedGroup = positional[2];
						if (requestedGroup && requestedGroup !== me.group_name) {
							host.notify(
								`${me.label} leads group ${me.group_name ?? "-"}; cannot spawn workers for ${requestedGroup}.`,
								"error",
							);
							return;
						}
						const spawned = spawnWorker(deps, me, { count: count ?? 1 });
						if (!spawned.ok) {
							host.notify(spawned.error, "error");
							return;
						}
						host.notify(
							`workers starting: ${spawned.value.map((worker) => `worker ${worker.index} (seat worker:${worker.slotId})`).join(", ")}`,
							"info",
						);
						return;
					}
					host.notify("/teams spawn project|group|worker ...", "error");
					return;
				}
				case "assign": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					const to = positional[1];
					const kind = positional[2];
					const difficulty = positional[3];
					const taskText = (rawArgs ?? "").trim().split(/\s+/).slice(4).join(" ").trim();
					if (!to || !kind || !difficulty || !taskText) {
						host.notify("/teams assign <to|queue> <kind> <difficulty> <task>", "error");
						return;
					}
					const result =
						to === "queue"
							? queueWork(routeDeps(runtime, spawnDeps()), me, {
									task: taskText,
									kind: kind as TaskKind,
									difficulty: difficulty as TaskDifficulty,
									requireOpenTask: false,
								})
							: await assignWork(routeDeps(runtime, spawnDeps()), me, {
									to,
									task: taskText,
									kind: kind as TaskKind,
									difficulty: difficulty as TaskDifficulty,
									requireOpenTask: false,
								});
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					const started = result.started ? ` (started ${result.started})` : "";
					host.notify(
						`assigned ${result.taskId} ${result.to ? `to ${result.to.label}` : "on the group queue"}${started}${result.model ? ` (model ${result.model})` : ""}`,
						"info",
					);
					return;
				}
				case "queue": {
					const me = host.refresh();
					if (!me?.group_name) {
						host.notify("the queue belongs to a group; this session is not in one.", "error");
						return;
					}
					host.notify(runtime.queueText(me), "info");
					return;
				}
				case "halt": {
					const me = host.refresh();
					if (!me || me.role === "worker") {
						host.notify("only a personal or repo leader can halt the team", "error");
						return;
					}
					const reason = (rawArgs ?? "").trim().split(/\s+/).slice(1).filter((word) => !word.startsWith("--")).join(" ");
					const result = runtime.halt(me, reason || `halted by ${me.label}`);
					host.notify(`team halted (${result.paused} group(s) paused). Running tasks finish; nothing new starts.`, "info");
					return;
				}
				case "digest": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					const config = runtime.configOf(me);
					const state = runtime.guard(me);
					const report = writeDailyReport({
						db: host.db,
						home: runtime.home,
						now: Date.now(),
						budgetUsd: config.guards.budget.daily_usd,
						spendUsd: state.spendToday,
						haltReason: state.haltReason,
						projectRoot: (id) => (id ? runtime.registry.projectRoot(id) : null),
					});
					host.notify(`report written: ${report.path}`, "info");
					await host.notifyHerdr(`omp-teams ${new Date().toLocaleDateString()}`, report.path);
					return;
				}
				case "audit": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					const hours = typeof flags.hours === "string" ? Number(flags.hours) : 24;
					const now = Date.now();
					const audit = writeAudit({ db: host.db, home: runtime.home, now, since: sinceFromHours(Number.isFinite(hours) ? hours : 24, now) });
					host.notify(
						`audit written: ${audit.path} (${Object.entries(audit.counts)
							.map(([table, count]) => `${table} ${count}`)
							.join(", ")})`,
						"info",
					);
					return;
				}
				case "bootstrap": {
					if (flags.yes !== true) {
						host.notify("/teams bootstrap --yes [--repo <path>] [--group <name>] [--count N]: builds personal -> repo leader -> group leader -> workers", "error");
						return;
					}
					const deps = spawnDeps();
					if (!deps) {
						host.notify("herdr is not available in this session; bootstrap needs herdr panes.", "error");
						return;
					}
					const me = host.refresh();
					if (!me || me.role !== "personal") {
						host.notify("run /teams bootstrap --yes in the personal leader's pane", "error");
						return;
					}
					const repoPath = typeof flags.repo === "string" ? expandPath(flags.repo) : ctx.cwd;
					const groupName = typeof flags.group === "string" ? flags.group : "main";
					const count = typeof flags.count === "string" ? Math.max(1, Math.min(4, Number(flags.count) || 2)) : 2;
					const project = spawnProject(deps, me, { repoPath });
					if (!project.ok) {
						host.notify(`project: ${project.error}`, "error");
						return;
					}
					host.notify(`repo leader spawned for ${project.value.project.name}; waiting for it to register…`, "info");
					const projectLead = await awaitSeat(runtime, `project:${project.value.project.id}`, 180_000);
					if (!projectLead) {
						host.notify("the repo leader did not register in time", "error");
						return;
					}
					const group = spawnGroup(deps, projectLead, { name: groupName });
					if (!group.ok) {
						host.notify(`group: ${group.error}`, "error");
						return;
					}
					host.notify(`group leader ${groupName} spawned; waiting for it to register…`, "info");
					const groupLead = await awaitSeat(runtime, `group:${project.value.project.id}/${groupName}`, 180_000);
					if (!groupLead) {
						host.notify("the group leader did not register in time", "error");
						return;
					}
					const workers = spawnWorker(deps, groupLead, { count });
					if (!workers.ok) {
						host.notify(`workers: ${workers.error}`, "error");
						return;
					}
					host.notify(
						`team is up: ${projectLead.label} → ${groupLead.label} → ${workers.value.length} worker seat(s) (+integrator). Queue work with teams_assign or /teams assign queue <kind> <difficulty> <task>.`,
						"info",
					);
					return;
				}
				case "pause":
				case "resume": {
					const me = host.refresh();
					if (sub === "resume" && !positional[1] && !flags.group) {
						if (!me) {
							host.notify("this session is not part of any team.", "error");
							return;
						}
						const result = runtime.resume(me);
						const deps = spawnDeps();
						const rebuiltText = deps
							? describeRebuild(rebuildMachine({ runtime, herdr: deps.herdr, home: runtime.home }))
							: "herdr is not available here, so panes were not rebuilt.";
						host.notify(
							`halt lifted${result.resumed ? `, ${result.resumed} group(s) resumed` : ""}${result.frozen ? `; the daily budget is still spent ($${formatUsd(result.spendToday)})` : ""}. ${rebuiltText}`,
							"info",
						);
						return;
					}
					const groupName = positional[1] ?? me?.group_name ?? null;
					if (!me || !groupName) {
						host.notify(`/teams ${sub} <group>`, "error");
						return;
					}
					const result = runtime.pause(me, groupName, sub === "pause");
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					host.notify(`group ${groupName} ${sub === "pause" ? "paused: workers finish their current task and stop claiming" : "resumed"}`, "info");
					return;
				}
				case "retire": {
					const me = host.refresh();
					const ref = positional[1];
					if (!me || !ref) {
						host.notify("/teams retire <worker>", "error");
						return;
					}
					const result = runtime.retire(me, ref);
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					host.notify(`${result.agent?.label ?? result.slot.id} stops after its current task`, "info");
					return;
				}
				case "accept-head": {
					const me = host.refresh();
					const groupName = positional[1] ?? me?.group_name ?? null;
					if (!me || !groupName) {
						host.notify("/teams accept-head <group>", "error");
						return;
					}
					const result = runtime.acceptHead(me, groupName);
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					host.notify(`group ${groupName}: head ${result.head.slice(0, 12)} accepted; held merges are queued again`, "info");
					return;
				}
				case "takeover":
				case "release": {
					const me = host.refresh();
					if (!me || me.role !== "worker") {
						host.notify("takeover and release apply to a worker pane.", "error");
						return;
					}
					const result = runtime.setManual(me, sub === "takeover");
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					host.notify(
						sub === "takeover"
							? `${me.label}: manual mode. No new tasks and no team mail until /teams release.`
							: `${me.label}: back under team control.`,
						"info",
					);
					return;
				}
				case "status": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team. Run /teams personal|project|group|join.", "info");
						return;
					}
					const children = runtime.registry.childrenOf(me.seat);
					const lines = [
						`label:    ${me.label}`,
						`role:     ${me.role}`,
						`seat:     ${me.seat}`,
						`manager:  ${me.parent_seat ?? "-"}`,
						`cwd:      ${me.cwd}`,
						`pane:     ${me.pane_id ?? "-"}`,
						`model:    ${me.model ?? "-"}`,
						`session:  ${me.session_file ?? me.session_id}`,
						`alive:    ${Math.round((Date.now() - me.last_seen) / 1000)}s since heartbeat`,
						`direct reports: ${children.length === 0 ? "none" : children.map((row) => `${row.status === "parked" ? `${PARKED_GLYPH} ` : ""}${row.label}`).join(", ")}`,
					];
					host.notify(lines.join("\n"), "info");
					return;
				}
				case "tree": {
					const me = host.refresh();
					const root = flags.all === true ? null : me;
					const nodes = buildTeamTree(runtime, root);
					if (nodes.length === 0) {
						host.notify("no team members are registered", "info");
						return;
					}
					if (flags.text === true || flags.paths === true || !ctx.hasUI || ctx.mode !== "tui") {
						host.notify(treeText(nodes, { selfId: me?.id ?? null, paths: flags.paths === true }).join("\n"), "info");
						return;
					}
					await showTreeOverlay(ctx, nodes, {
						title: root ? `team below ${root.label}` : "whole team on this machine",
						selfId: me?.id ?? null,
					});
					return;
				}
				case "report": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					const text = rawArgs.trim().slice("report".length).trim();
					if (!text) {
						host.notify("/teams report <text>", "error");
						return;
					}
					const result = runtime.report(me, { summary: text, status: "progress" });
					if (!result.ok) {
						host.notify(result.error, "error");
						return;
					}
					host.notify(`reported to ${result.to.label}`, "info");
					return;
				}
				case "progress": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "error");
						return;
					}
					if (flags.fresh === true) {
						const asked = runtime.requestFreshStatus(me);
						if (!asked.ok) {
							host.notify(asked.error, "error");
							return;
						}
						host.notify(`asked ${asked.asked.join(", ")} for a fresh status; answers arrive as reports`, "info");
						return;
					}
					const entries = runtime.progress(me);
					if (entries.length === 0) {
						host.notify("no direct subordinates", "info");
						return;
					}
					const lines = entries.map((entry) => {
						const report = entry.lastReport;
						const when = report ? `${Math.round((Date.now() - report.at) / 60000)}m ago` : "never";
						const status = entry.agent.status === "parked" ? "parked" : (report?.status ?? "unknown");
						const summary = report?.summary?.replace(/\s+/g, " ").slice(0, 160) ?? "";
						const mark = entry.agent.status === "parked" ? `${PARKED_GLYPH} ` : "";
						return `${mark}${entry.agent.label}  ${status}  ${report?.taskId ?? ""}  ${when}  ${summary}`.trim();
					});
					host.notify(lines.join("\n"), "info");
					return;
				}
				case "leave": {
					const me = host.refresh();
					if (!me) {
						host.notify("this session is not part of any team.", "info");
						return;
					}
					const children = runtime.registry.childrenOf(me.seat);
					if (children.length > 0) {
						host.notify(
							`${me.label} still has direct reports: ${children.map((row) => row.label).join(", ")}. Ask them to run /teams leave first.`,
							"error",
						);
						return;
					}
					runtime.leave(me);
					await host.applyToolPolicy();
					host.notify(`${me.label} left the team`, "info");
					if (process.env.OMP_TEAMS_STOP) host.stopMember();
					return;
				}
				default:
					host.notify(`unknown subcommand "${sub}"\n\n${USAGE}`, "error");
			}
		},
	});
}

async function finishRegistration(
	host: TeamsHost,
	ctx: ExtensionCommandContext,
	role: Role,
	label: string,
): Promise<void> {
	host.refresh();
	await host.applyToolPolicy();
	const hints: Record<Role, string> = {
		personal: "Register project managers with /teams project inside each repository.",
		project: "Register group leads with /teams group <name> --new-worktree.",
		group: "Register workers with /teams join <group> from inside the group worktree.",
		worker: "Wait for tasks; report back with teams_report.",
	};
	host.notify(`${label} registered as ${role}. ${hints[role]}`, "info");
}
