import type { SymbolKey } from "@oh-my-pi/pi-tui/theme/symbols";
import { displayName, RANK_GLYPH } from "./identity";
import type { AgentRow } from "./registry";

export { displayName };

export interface TeamCounts {
	projects: number;
	groups: number;
	workers: number;
	queued: number;
	running: number;
	done: number;
	blocked: number;
	unread: number;
}

export interface PresenceInput {
	agent: AgentRow;
	counts: TeamCounts;
	parentLabel: string | null;
	parentAlive: boolean;
	currentTaskId?: string | null;
	currentTaskTitle: string | null;
	manual: boolean;
	branch?: string | null;
	paused?: boolean;
	halted?: boolean;
	budgetSpent?: boolean;
	integrator?: boolean;
}

export type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "branch";

export interface Segment {
	icon?: SymbolKey;
	glyph?: string;
	text: string;
	tone: Tone;
	bold?: boolean;
}

export interface Painter {
	icon(key: SymbolKey): string;
	paint(tone: Tone, text: string, bold?: boolean): string;
	separator(): string;
}

const PLAIN_ICONS: Partial<Record<SymbolKey, string>> = {
	"icon.branch": "⑂",
	"icon.pause": "⏸",
	"icon.input": "⤵",
	"status.running": "⟳",
	"status.pending": "⏳",
	"status.done": "•",
	"status.warning": "⚠",
	"status.error": "✘",
};

export const PLAIN_PAINTER: Painter = {
	icon: (key) => PLAIN_ICONS[key] ?? "•",
	paint: (_tone, text) => text,
	separator: () => "│",
};

export function truncate(text: string, limit: number): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function statusSegments(input: PresenceInput): Segment[] {
	const { agent, counts } = input;
	const segments: Segment[] = [{ glyph: RANK_GLYPH[agent.role], text: displayName(agent.label), tone: "accent", bold: true }];

	if (input.branch && agent.role !== "personal" && agent.role !== "project") {
		segments.push({ icon: "icon.branch", text: input.branch, tone: "branch" });
	}

	switch (agent.role) {
		case "personal":
			segments.push({ glyph: RANK_GLYPH.project, text: plural(counts.projects, "repo leader"), tone: "muted" });
			segments.push({ glyph: RANK_GLYPH.group, text: plural(counts.groups, "group leader"), tone: "muted" });
			segments.push({ glyph: RANK_GLYPH.worker, text: plural(counts.workers, "worker"), tone: "muted" });
			if (counts.running > 0) segments.push({ icon: "status.running", text: `${counts.running} running`, tone: "accent" });
			break;
		case "project":
			segments.push({ glyph: RANK_GLYPH.group, text: plural(counts.groups, "group leader"), tone: "muted" });
			segments.push({ glyph: RANK_GLYPH.worker, text: plural(counts.workers, "worker"), tone: "muted" });
			if (counts.running > 0) segments.push({ icon: "status.running", text: `${counts.running} running`, tone: "accent" });
			if (counts.done > 0) segments.push({ icon: "status.done", text: `${counts.done} done`, tone: "success" });
			break;
		case "group":
			segments.push({ glyph: RANK_GLYPH.worker, text: plural(counts.workers, "worker"), tone: "muted" });
			if (counts.queued > 0) segments.push({ icon: "status.pending", text: `${counts.queued} queued`, tone: "muted" });
			if (counts.running > 0) segments.push({ icon: "status.running", text: `${counts.running} running`, tone: "accent" });
			if (counts.done > 0) segments.push({ icon: "status.done", text: `${counts.done} done`, tone: "success" });
			break;
		case "worker":
			segments.push(
				input.currentTaskTitle
					? {
							icon: "status.running",
							text: `${input.currentTaskId ? `${input.currentTaskId} ` : ""}${truncate(input.currentTaskTitle, 48)}`,
							tone: "accent",
						}
					: { icon: "status.pending", text: input.integrator ? "waiting for merges" : "waiting for a task", tone: "dim" },
			);
			break;
	}

	if (counts.blocked > 0) segments.push({ icon: "status.warning", text: `${counts.blocked} blocked`, tone: "warning", bold: true });
	if (input.halted) segments.push({ icon: "icon.pause", text: "halted", tone: "error", bold: true });
	if (input.budgetSpent) segments.push({ icon: "status.warning", text: "budget spent", tone: "error", bold: true });
	if (input.paused) segments.push({ icon: "icon.pause", text: "paused", tone: "warning" });
	if (input.manual) segments.push({ icon: "icon.input", text: "manual", tone: "warning", bold: true });
	if (input.parentLabel) {
		segments.push(
			input.parentAlive
				? { text: `↑ ${displayName(input.parentLabel)}`, tone: "dim" }
				: { icon: "status.error", text: `↑ ${displayName(input.parentLabel)} offline`, tone: "error" },
		);
	}
	if (counts.unread > 0) segments.push({ text: `✉ ${counts.unread}`, tone: "warning" });
	return segments;
}

export function renderSegments(segments: Segment[], painter: Painter): string {
	return segments
		.map((segment) => {
			const mark = segment.glyph ?? (segment.icon ? painter.icon(segment.icon) : null);
			const text = mark ? `${mark} ${segment.text}` : segment.text;
			return painter.paint(segment.tone, text, segment.bold);
		})
		.join(` ${painter.separator()} `);
}

export function statusLine(input: PresenceInput, painter: Painter = PLAIN_PAINTER): string {
	return renderSegments(statusSegments(input), painter);
}

export function paneStateLabels(input: PresenceInput): Record<string, string> {
	const { agent, counts } = input;
	const task = input.currentTaskTitle ? truncate(input.currentTaskTitle, 34) : null;
	if (input.manual) {
		return { idle: "✋ 人工接管", working: "✋ 人工", blocked: `⚠ ${counts.blocked} blocked` };
	}
	if (counts.blocked > 0) {
		return { working: task ? `▶ ${task}` : "▶ 处理中", idle: `⚠ ${counts.blocked} blocked`, blocked: `⚠ ${counts.blocked} blocked` };
	}
	if (agent.role === "worker") {
		return { working: task ? `▶ ${task}` : "▶ 处理中", idle: "✓ 等待派活", blocked: "⚠ 需人工" };
	}
	return {
		working: "▶ 协调中",
		idle: `✓ ${counts.queued} queued · ${counts.running} running`,
		blocked: `⚠ ${counts.blocked} blocked`,
	};
}

export function paneTitle(input: PresenceInput): string {
	const task = input.currentTaskTitle ? `: ${truncate(input.currentTaskTitle, 36)}` : "";
	return `${input.agent.label}${task}`;
}

export interface WidgetEntry {
	agent: AgentRow;
	session: string;
	current: { id: string; title: string } | null;
	lastReport: { status: string; summary: string; at: number } | null;
}

function age(now: number, at: number): string {
	const minutes = Math.max(0, Math.round((now - at) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

export function widgetLines(entries: WidgetEntry[], now: number, painter: Painter = PLAIN_PAINTER, max = 10): string[] {
	if (entries.length === 0) return [];
	const width = Math.min(18, Math.max(...entries.map((entry) => displayName(entry.agent.label).length)));
	const shown = entries.length > max ? entries.slice(0, max - 1) : entries;
	const rows = shown.map((entry) => {
		const name = painter.paint("accent", displayName(entry.agent.label).padEnd(width), true);
		const report = entry.lastReport;
		let state: string;
		if (report?.status === "blocked" || report?.status === "failed") {
			state = painter.paint("warning", `${painter.icon("status.warning")} ${report.status}: ${truncate(report.summary, 56)}`);
		} else if (entry.current) {
			state = painter.paint("accent", `${painter.icon("status.running")} ${entry.current.id} ${truncate(entry.current.title, 52)}`);
		} else if (report) {
			state = painter.paint(report.status === "done" ? "success" : "muted", `${painter.icon(report.status === "done" ? "status.done" : "status.pending")} ${truncate(report.summary, 56)}`);
		} else {
			state = painter.paint("dim", `${painter.icon("status.pending")} idle`);
		}
		const when = report ? painter.paint("dim", ` · ${age(now, report.at)}`) : "";
		const session = painter.paint("muted", ` · session ${entry.session}`);
		return `${name}  ${state}${when}${session}`;
	});
	if (entries.length > max) rows.push(painter.paint("dim", `… ${entries.length - shown.length} more (see /teams tree)`));
	return rows;
}
