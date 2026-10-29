import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { decideDelivery, Mailer, persistedMsgIds, renderMail, wakeFor } from "../src/mail";

let home: string;
let db: Database;
let mailer: Mailer;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-teams-mail-"));
	db = openDb(home);
	mailer = new Mailer(db, () => 1_000);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("delivery policy", () => {
	test("a wake message starts a turn when idle and queues behind a running one", () => {
		expect(decideDelivery("task", true, false)).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
			abortFirst: false,
			passive: false,
		});
		expect(decideDelivery("task", true, true)).toEqual({
			deliverAs: "followUp",
			triggerTurn: true,
			abortFirst: false,
			passive: false,
		});
	});

	test("passive mail never starts a turn, idle or busy", () => {
		expect(decideDelivery("report", false, false)).toEqual({
			deliverAs: "nextTurn",
			triggerTurn: false,
			abortFirst: false,
			passive: true,
		});
		expect(decideDelivery("report", false, true).deliverAs).toBe("nextTurn");
		expect(decideDelivery("report", false, true).triggerTurn).toBe(false);
	});

	test("cancel interrupts a busy member before landing", () => {
		expect(decideDelivery("cancel", true, true).abortFirst).toBe(true);
		expect(decideDelivery("cancel", true, false).abortFirst).toBe(false);
	});

	test("only turn-ending statuses wake a manager", () => {
		expect(wakeFor("report", { status: "progress" })).toBe(false);
		expect(wakeFor("report", { status: "done" })).toBe(true);
		expect(wakeFor("report", { status: "blocked" })).toBe(true);
		expect(wakeFor("task", {})).toBe(true);
		expect(wakeFor("progress", {})).toBe(false);
	});
});

describe("mailbox", () => {
	test("undelivered mail is delivered once and stays out of later inbox reads", () => {
		const id = mailer.send({
			fromAgent: "a-1",
			fromSeat: "group:p-1/feat-x",
			toSeat: "worker:a-2",
			toAgent: "a-2",
			kind: "task",
			body: { task_id: "T-1", title: "fix thing", kind: "fix", difficulty: "simple" },
		});

		const first = mailer.inbox("worker:a-2");
		expect(first.map((row) => row.id)).toEqual([id]);
		expect(first[0]?.wake).toBe(1);

		mailer.markDelivered([id]);
		expect(mailer.inbox("worker:a-2")).toEqual([]);
		expect(mailer.inbox("worker:other")).toEqual([]);
	});

	test("acknowledging marks both delivery and ack time", () => {
		const id = mailer.send({
			fromAgent: "a-1",
			fromSeat: "personal",
			toSeat: "project:p-1",
			kind: "report",
			body: { status: "progress", summary: "halfway" },
		});
		mailer.markAcked([id]);
		const row = db.query("SELECT delivered_at, acked_at FROM messages WHERE id = ?").get(id) as {
			delivered_at: number | null;
			acked_at: number | null;
		};
		expect(row.acked_at).toBe(1_000);
		expect(row.delivered_at).toBe(1_000);
	});

	test("rendered task mail carries the task id and the report instruction", () => {
		const id = mailer.send({
			fromAgent: "a-1",
			fromSeat: "group:p-1/feat-x",
			toSeat: "worker:a-2",
			kind: "task",
			body: {
				task_id: "T-42",
				title: "fix tokenizer",
				kind: "fix",
				difficulty: "normal",
				model: "deepseek/deepseek-v4-flash",
				text: "details here",
			},
		});
		const row = mailer.inbox("worker:a-2").find((candidate) => candidate.id === id);
		if (!row) throw new Error("mail not found");
		const rendered = renderMail(row, "◆ lead·feat-x");
		expect(rendered).toContain("[teams task T-42]");
		expect(rendered).toContain("from ◆ lead·feat-x");
		expect(rendered).toContain("details here");
		expect(rendered).toContain('teams_report({ task_id: "T-42"');
	});

	test("latest report per sender is what progress reads", () => {
		mailer.send({
			fromAgent: "a-2",
			fromSeat: "worker:a-2",
			toSeat: "group:p-1/feat-x",
			toAgent: "a-1",
			kind: "report",
			body: { status: "progress", summary: "first" },
		});
		mailer.send({
			fromAgent: "a-2",
			fromSeat: "worker:a-2",
			toSeat: "group:p-1/feat-x",
			toAgent: "a-1",
			kind: "report",
			body: { status: "done", summary: "second" },
		});
		const reports = mailer.recentReports("group:p-1/feat-x");
		expect(reports[0]?.body).toContain("second");
	});
});

describe("wake hook", () => {
	test("waking mail calls the hook once for its seat and passive mail does not", () => {
		const woken: string[] = [];
		const hooked = new Mailer(db, () => 1_000, (seat) => woken.push(seat));
		hooked.send({
			fromAgent: "a-1",
			fromSeat: "personal",
			toSeat: "project:p-1",
			kind: "ask",
			body: { text: "which branch?" },
		});
		expect(woken).toEqual(["project:p-1"]);
		hooked.send({
			fromAgent: "a-2",
			fromSeat: "group:p-1/feat-x",
			toSeat: "project:p-1",
			kind: "report",
			body: { status: "progress", summary: "half way" },
		});
		expect(woken).toEqual(["project:p-1"]);
	});
});

describe("acknowledgement scanning", () => {
	test("message ids are read from persisted team-mail entries only", () => {
		const ids = persistedMsgIds([
			{ type: "message" },
			{ type: "custom_message", customType: "other", details: { teamsMsgIds: ["m-skip"] } },
			{ type: "custom_message", customType: "teams-mail", details: { teamsMsgIds: ["m-1", "m-2"] } },
			{ type: "custom_message", customType: "teams-mail", details: { teamsMsgIds: ["m-3"] } },
		]);
		expect(ids).toEqual(["m-1", "m-2", "m-3"]);
	});

	test("malformed details do not break the scan", () => {
		expect(persistedMsgIds([{ type: "custom_message", customType: "teams-mail", details: null }])).toEqual([]);
		expect(
			persistedMsgIds([{ type: "custom_message", customType: "teams-mail", details: { teamsMsgIds: "m-1" } }]),
		).toEqual([]);
	});
});
