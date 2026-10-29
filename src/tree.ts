import type { ExtensionCommandContext } from "@oh-my-pi/pi-coding-agent";
import { displayName, PARKED_GLYPH, RANK_GLYPH, sessionTag } from "./identity";
import { type Painter, PLAIN_PAINTER, truncate } from "./presence";
import type { TaskRow } from "./queue";
import type { AgentRow } from "./registry";
import type { TeamsRuntime } from "./runtime";

export interface TeamTreeNode {
	agent: AgentRow;
	session: string;
	task: TaskRow | null;
	integrator: boolean;
	children: TeamTreeNode[];
}

export function buildTeamTree(runtime: TeamsRuntime, root: AgentRow | null): TeamTreeNode[] {
	const members = runtime.registry.allHolders();
	const pool = members.map((row) => row.session_id);
	const bySeat = new Map(members.map((row) => [row.seat, row]));
	const build = (agent: AgentRow, seen: Set<string>): TeamTreeNode => {
		seen.add(agent.id);
		const children = members.filter((row) => row.parent_seat === agent.seat && !seen.has(row.id));
		return {
			agent,
			session: sessionTag(agent.session_id, pool),
			task: runtime.currentTask(agent),
			integrator: runtime.slotOf(agent)?.kind === "integrator",
			children: children.map((child) => build(child, seen)),
		};
	};
	const seen = new Set<string>();
	if (root) return [build(root, seen)];
	return members
		.filter((row) => !row.parent_seat || !bySeat.has(row.parent_seat))
		.map((row) => build(row, seen));
}

export interface TreeRowView {
	node: TeamTreeNode;
	depth: number;
	ancestorsLast: boolean[];
	isLast: boolean;
}

export function flattenTree(nodes: TeamTreeNode[]): TreeRowView[] {
	const rows: TreeRowView[] = [];
	const walk = (list: TeamTreeNode[], depth: number, ancestorsLast: boolean[]): void => {
		list.forEach((node, index) => {
			const isLast = index === list.length - 1;
			rows.push({ node, depth, ancestorsLast, isLast });
			walk(node.children, depth + 1, [...ancestorsLast, isLast]);
		});
	};
	walk(nodes, 0, []);
	return rows;
}

export interface TreeGlyphs {
	vertical: string;
	branch: string;
	last: string;
}

const PLAIN_TREE: TreeGlyphs = { vertical: "│", branch: "├─", last: "└─" };

function gutter(row: TreeRowView, glyphs: TreeGlyphs): string {
	if (row.depth === 0) return "";
	const ancestors = row.ancestorsLast
		.slice(1)
		.map((last) => (last ? "   " : `${glyphs.vertical}  `))
		.join("");
	return `${ancestors}${row.isLast ? glyphs.last : glyphs.branch} `;
}

function rowBody(node: TeamTreeNode, painter: Painter, selfId: string | null): string {
	const name = painter.paint("accent", `${RANK_GLYPH[node.agent.role]} ${displayName(node.agent.label)}`, true);
	const you = node.agent.id === selfId ? painter.paint("warning", " (you)") : "";
	const state =
		node.agent.status === "parked"
			? painter.paint("dim", `${PARKED_GLYPH} parked`)
			: node.task
				? painter.paint("accent", `${painter.icon("status.running")} ${node.task.id} ${truncate(node.task.title, 44)}`)
				: painter.paint("dim", `${painter.icon("status.pending")} ${node.integrator ? "waiting for merges" : "idle"}`);
	const session = painter.paint("muted", `session ${node.session}`);
	return `${name}${you}  ${state}  ${session}`;
}

export function treeText(
	nodes: TeamTreeNode[],
	options: { painter?: Painter; glyphs?: TreeGlyphs; selfId?: string | null; paths?: boolean } = {},
): string[] {
	const painter = options.painter ?? PLAIN_PAINTER;
	const glyphs = options.glyphs ?? PLAIN_TREE;
	const lines: string[] = [];
	for (const row of flattenTree(nodes)) {
		const prefix = painter.paint("dim", gutter(row, glyphs));
		lines.push(`${prefix}${rowBody(row.node, painter, options.selfId ?? null)}`);
		if (options.paths) {
			const indent = " ".repeat(gutter(row, glyphs).length + 4);
			lines.push(painter.paint("dim", `${indent}${row.node.agent.session_file ?? row.node.agent.session_id}`));
		}
	}
	return lines;
}

export function memberDetails(agent: AgentRow): string[] {
	return [
		`session  ${agent.session_id}`,
		`file     ${agent.session_file ?? "-"}`,
		`pane     ${agent.pane_id ?? "-"}    model ${agent.model ?? "-"}`,
		`cwd      ${agent.cwd}`,
	];
}

const MAX_VISIBLE_ROWS = 18;

export async function showTreeOverlay(
	ctx: ExtensionCommandContext,
	nodes: TeamTreeNode[],
	options: { title: string; selfId: string | null },
): Promise<void> {
	const rows = flattenTree(nodes);
	if (rows.length === 0) return;
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		let selected = Math.max(0, rows.findIndex((row) => row.node.agent.id === options.selfId));
		const painter: Painter = {
			icon: (key) => theme.symbol(key),
			paint: (tone, text, bold) => {
				const color = tone === "branch" ? "statusLineGitClean" : tone;
				const colored = theme.fg(color, text);
				return bold ? theme.bold(colored) : colored;
			},
			separator: () => theme.fg("statusLineSep", theme.symbol("sep.powerlineThin")),
		};
		const glyphs: TreeGlyphs = { vertical: theme.tree.vertical, branch: theme.tree.branch, last: theme.tree.last };
		const fit = (line: string, width: number): string => {
			let visible = 0;
			let out = "";
			for (let i = 0; i < line.length; i++) {
				const char = line[i] as string;
				if (char === "\u001b") {
					const end = line.indexOf("m", i);
					if (end > i) {
						out += line.slice(i, end + 1);
						i = end;
						continue;
					}
				}
				if (visible >= width) break;
				out += char;
				visible++;
			}
			return `${out}\u001b[0m`;
		};
		return {
			render(width: number): readonly string[] {
				const start = Math.max(0, Math.min(selected - Math.floor(MAX_VISIBLE_ROWS / 2), rows.length - MAX_VISIBLE_ROWS));
				const window = rows.slice(start, start + MAX_VISIBLE_ROWS);
				const lines = [
					theme.fg("accent", theme.bold(options.title)),
					theme.fg("dim", `${rows.length} member${rows.length === 1 ? "" : "s"} · ↑↓ move · esc close`),
					"",
				];
				window.forEach((row, offset) => {
					const index = start + offset;
					const cursor = index === selected ? theme.fg("accent", "❯ ") : "  ";
					lines.push(fit(`${cursor}${theme.fg("dim", gutter(row, glyphs))}${rowBody(row.node, painter, options.selfId)}`, width));
				});
				if (rows.length > window.length) lines.push(theme.fg("dim", `  … ${rows.length - window.length} more`));
				const current = rows[selected]?.node.agent;
				if (current) {
					lines.push("", theme.fg("accent", `${RANK_GLYPH[current.role]} ${displayName(current.label)}`));
					for (const detail of memberDetails(current)) lines.push(fit(theme.fg("muted", `  ${detail}`), width));
				}
				return lines;
			},
			invalidate() {},
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel") || data === "q") {
					done(undefined);
					return;
				}
				if (keybindings.matches(data, "tui.select.up") || data === "k") selected = Math.max(0, selected - 1);
				else if (keybindings.matches(data, "tui.select.down") || data === "j") selected = Math.min(rows.length - 1, selected + 1);
				else if (keybindings.matches(data, "tui.select.pageUp")) selected = Math.max(0, selected - MAX_VISIBLE_ROWS);
				else if (keybindings.matches(data, "tui.select.pageDown")) selected = Math.min(rows.length - 1, selected + MAX_VISIBLE_ROWS);
				else if (keybindings.matches(data, "tui.select.confirm")) {
					done(undefined);
					return;
				}
				tui.requestRender();
			},
		};
	});
}
