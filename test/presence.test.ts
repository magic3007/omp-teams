import { describe, expect, test } from "bun:test";
import {
	displayName,
	type Painter,
	type PresenceInput,
	paneStateLabels,
	paneTitle,
	statusLine,
	statusSegments,
	truncate,
	widgetLines,
} from "../src/presence";
import { labelFor } from "../src/identity";
import type { AgentRow } from "../src/registry";

function agent(overrides: Partial<AgentRow>): AgentRow {
	return {
		id: "a-1",
		seat: "personal",
		role: "personal",
		label: "★★★ personal leader",
		project_id: null,
		project_name: null,
		group_name: null,
		parent_seat: null,
		session_id: "s-1",
		session_file: null,
		cwd: "/home/x",
		pane_id: "w:p1",
		model: null,
		status: "alive",
		registered_at: 0,
		last_seen: 0,
		...overrides,
	};
}

const counts = { projects: 3, groups: 4, workers: 18, queued: 3, running: 5, done: 7, blocked: 0, unread: 0 };

function input(overrides: Partial<PresenceInput>): PresenceInput {
	return {
		agent: agent({}),
		counts,
		parentLabel: null,
		parentAlive: true,
		currentTaskTitle: null,
		manual: false,
		...overrides,
	};
}

const TAG_PAINTER: Painter = {
	icon: (key) => `<${key}>`,
	paint: (tone, text, bold) => `[${tone}${bold ? "!" : ""}:${text}]`,
	separator: () => "|",
};

describe("status line", () => {
	test("each level leads with its rank stars and its full, unabbreviated name", () => {
		expect(statusSegments(input({}))[0]).toEqual({ glyph: "★★★", text: "personal leader", tone: "accent", bold: true });
		const project = agent({ role: "project", seat: "project:p-1", label: labelFor("project", { projectName: "repo" }) });
		expect(statusSegments(input({ agent: project }))[0]).toMatchObject({ glyph: "★★", text: "repo leader · repo" });
		const lead = agent({ role: "group", seat: "group:p-1/g", label: labelFor("group", { group: "g" }) });
		expect(statusSegments(input({ agent: lead }))[0]).toMatchObject({ glyph: "★", text: "group leader · g" });
		const worker = agent({ role: "worker", seat: "worker:s-1", label: labelFor("worker", { group: "g", index: 1 }) });
		expect(statusSegments(input({ agent: worker }))[0]).toMatchObject({ glyph: "☆", text: "worker 1 · g" });
		const integrator = agent({ role: "worker", seat: "worker:s-2", label: labelFor("worker", { group: "g", integrator: true }) });
		expect(statusSegments(input({ agent: integrator, integrator: true }))[0]).toMatchObject({ glyph: "☆", text: "integrator · g" });
	});

	test("head counts carry the rank of the level they count", () => {
		const segments = statusSegments(input({ counts: { ...counts, projects: 2, groups: 3, workers: 9 } }));
		expect(segments.slice(1, 4)).toEqual([
			{ glyph: "★★", text: "2 repo leaders", tone: "muted" },
			{ glyph: "★", text: "3 group leaders", tone: "muted" },
			{ glyph: "☆", text: "9 workers", tone: "muted" },
		]);
	});

	test("a worker shows its branch, its live task, and its lead", () => {
		const worker = agent({ role: "worker", seat: "worker:s-1", label: labelFor("worker", { group: "feat-x", index: 3 }), parent_seat: "group:p-1/feat-x" });
		const line = statusLine(
			input({
				agent: worker,
				branch: "teams-w/feat-x/w3",
				currentTaskId: "T-17ab",
				currentTaskTitle: "fix tokenizer overflow",
				parentLabel: labelFor("group", { group: "feat-x" }),
			}),
			TAG_PAINTER,
		);
		expect(line).toBe(
			"[accent!:☆ worker 3 · feat-x] | [branch:<icon.branch> teams-w/feat-x/w3] | [accent:<status.running> T-17ab fix tokenizer overflow] | [dim:↑ group leader · feat-x]",
		);
	});

	test("an idle worker says it is waiting, the integrator says what it waits for", () => {
		const worker = agent({ role: "worker", seat: "worker:s-1", label: labelFor("worker", { group: "g", index: 1 }) });
		expect(statusLine(input({ agent: worker }))).toContain("waiting for a task");
		expect(statusLine(input({ agent: worker, integrator: true }))).toContain("waiting for merges");
	});

	test("what needs attention is painted as a warning; an offline manager as an error", () => {
		const lead = agent({ role: "group", seat: "group:p-1/g", label: labelFor("group", { group: "g" }), parent_seat: "project:p-1" });
		const line = statusLine(
			input({
				agent: lead,
				counts: { ...counts, blocked: 2, unread: 1 },
				paused: true,
				parentLabel: labelFor("project", { projectName: "repo" }),
				parentAlive: false,
			}),
			TAG_PAINTER,
		);
		expect(line).toContain("[warning!:<status.warning> 2 blocked]");
		expect(line).toContain("[warning:<icon.pause> paused]");
		expect(line).toContain("[error:<status.error> ↑ repo leader · repo offline]");
		expect(line).toContain("[warning:✉ 1]");
	});

	test("zero counts are left out instead of cluttering the line", () => {
		const lead = agent({ role: "group", seat: "group:p-1/g", label: labelFor("group", { group: "g" }) });
		const line = statusLine(input({ agent: lead, counts: { ...counts, queued: 0, running: 0, done: 0 } }));
		expect(line).not.toContain("queued");
		expect(line).not.toContain("running");
		expect(line).not.toContain("done");
		expect(line).not.toContain("blocked");
	});

	test("the plain painter draws the same line without colours", () => {
		expect(statusLine(input({}))).toBe("★★★ personal leader │ ★★ 3 repo leaders │ ★ 4 group leaders │ ☆ 18 workers │ ⟳ 5 running");
	});
});

describe("pane metadata", () => {
	test("worker state labels describe the current task and the idle state", () => {
		const labels = paneStateLabels(
			input({ agent: agent({ role: "worker", seat: "worker:s-1", label: labelFor("worker", { group: "feat-x", index: 3 }) }), currentTaskTitle: "fix tokenizer overflow" }),
		);
		expect(labels.working).toBe("▶ fix tokenizer overflow");
		expect(labels.idle).toBe("✓ 等待派活");
	});

	test("manual takeover and blockers win over the task label", () => {
		const base = input({ agent: agent({ role: "group", seat: "group:p-1/g", label: labelFor("group", { group: "g" }) }), counts: { ...counts, blocked: 3 } });
		expect(paneStateLabels({ ...base, manual: true }).idle).toBe("✋ 人工接管");
		expect(paneStateLabels(base).idle).toContain("3 blocked");
	});

	test("pane title carries identity and the task", () => {
		expect(paneTitle(input({ agent: agent({ role: "worker", label: "☆ worker 1 · feat-x" }), currentTaskTitle: "do a thing" }))).toBe(
			"☆ worker 1 · feat-x: do a thing",
		);
	});
});

describe("manager widget", () => {
	const entry = (index: number, extra: Partial<Parameters<typeof widgetLines>[0][number]> = {}) => ({
		agent: agent({ id: `a-${index}`, role: "worker", label: labelFor("worker", { group: "g", index }) }),
		session: `01a18300-4cf${index}`,
		current: null,
		lastReport: null,
		...extra,
	});

	test("never exceeds ten rows, the last one counting the rest", () => {
		const rows = widgetLines(Array.from({ length: 12 }, (_, index) => entry(index)), 0);
		expect(rows.length).toBe(10);
		expect(rows[9]).toContain("3 more");
		expect(widgetLines(Array.from({ length: 10 }, (_, index) => entry(index)), 0).length).toBe(10);
	});

	test("a row shows the live task, a blocker, or the last report with its age", () => {
		const running = widgetLines([entry(1, { current: { id: "T-1", title: "build it" } })], 0, TAG_PAINTER)[0];
		expect(running).toContain("[accent:<status.running> T-1 build it]");
		const blocked = widgetLines([entry(2, { lastReport: { status: "blocked", summary: "need a schema", at: 0 } })], 120_000, TAG_PAINTER)[0];
		expect(blocked).toContain("[warning:<status.warning> blocked: need a schema]");
		expect(blocked).toContain("[dim: · 2m]");
		const idle = widgetLines([entry(3)], 0, TAG_PAINTER)[0];
		expect(idle).toContain("[dim:<status.pending> idle]");
		expect(idle).toContain("[muted: · session 01a18300-4cf3]");
	});

	test("an empty manager renders nothing", () => {
		expect(widgetLines([], Date.now())).toEqual([]);
	});
});

describe("text helpers", () => {
	test("truncate collapses whitespace and clips with an ellipsis", () => {
		expect(truncate("a\n\n b   c", 40)).toBe("a b c");
		expect(truncate("abcdefghij", 5)).toBe("abcd…");
	});

	test("displayName drops only the rank stars", () => {
		expect(displayName("★★★ personal leader")).toBe("personal leader");
		expect(displayName("★★ repo leader · repo")).toBe("repo leader · repo");
		expect(displayName("☆ integrator · g")).toBe("integrator · g");
		expect(displayName("plain")).toBe("plain");
	});
});
