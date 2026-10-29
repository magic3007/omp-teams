/**
 * Mailbox transport and delivery policy.
 *
 * Messages are rows. A member injects its own undelivered rows into its own
 * session, so delivery never depends on the sender being alive.
 *
 * Delivery policy (verified against `agent-session.ts`):
 *   - `followUp` with `triggerTurn` starts a turn even when idle.
 *   - `followUp`/`steer` without `triggerTurn` only appends to history when
 *     idle, so a task sent that way would never run.
 *   - `nextTurn` without `triggerTurn` persists the message with no turn: the
 *     right shape for passive reports.
 *   - `aside` always starts a turn when idle: reserve it for wakes.
 */
import type { Database } from "bun:sqlite";
import { logEvent } from "./db";
import { shortId } from "./identity";

export type MailKind = "task" | "report" | "ask" | "answer" | "cancel" | "progress" | "ping" | "notice";

/** A `ping` with `fresh` asks the receiver for a freshly written status. */

export type DeliverAs = "steer" | "followUp" | "nextTurn" | "aside";

export interface MailBody {
	task_id?: string;
	title?: string;
	summary?: string;
	status?: string;
	sha?: string;
	kind?: string;
	difficulty?: string;
	model?: string;
	paths?: string[];
	text?: string;
	/** A `ping` with this flag asks for a freshly written status. */
	fresh?: boolean;
}

export interface MailRow {
	id: string;
	/** Task this message carries, for task mail; lets delivery mark the task running. */
	task_id: string | null;
	from_agent: string;
	from_seat: string;
	to_seat: string;
	to_agent: string | null;
	kind: MailKind;
	wake: number;
	body: string;
	created_at: number;
	delivered_at: number | null;
	acked_at: number | null;
}

export interface DeliveryDecision {
	deliverAs: DeliverAs;
	triggerTurn: boolean;
	/** Cancel interrupts an in-flight turn before the message lands. */
	abortFirst: boolean;
	/** Passive mail may be merged with other passive mail into one injection. */
	passive: boolean;
}

const WAKE_KINDS: Record<string, true> = { task: true, cancel: true, ask: true, notice: true };

/** Turn-ending report statuses must wake a manager; steady progress must not. */
const WAKE_STATUSES: Record<string, true> = { done: true, failed: true, blocked: true };

/** Whether this message may start a turn on the receiving side. */
export function wakeFor(kind: MailKind, body: MailBody): boolean {
	if (WAKE_KINDS[kind]) return true;
	if (kind === "report" && body.status && WAKE_STATUSES[body.status]) return true;
	return false;
}

export function decideDelivery(kind: MailKind, wake: boolean, receiverBusy: boolean): DeliveryDecision {
	if (wake) {
		// `followUp` + `triggerTurn` is correct in both states: idle starts the turn, busy
		// queues the message as a follow-up without interrupting the running tool batch.
		return { deliverAs: "followUp", triggerTurn: true, abortFirst: kind === "cancel" && receiverBusy, passive: false };
	}
	// Passive mail never starts a turn; `nextTurn` persists it on an idle member and
	// queues it for the next turn on a busy one.
	return { deliverAs: "nextTurn", triggerTurn: false, abortFirst: false, passive: true };
}

/**
 * Render one message as the text a member sees in its transcript. `preface`
 * frames a task for its receiver's role (a worker's own worktree, a leader's
 * duty to delegate), whatever the task text says.
 */
export function renderMail(row: MailRow, fromLabel: string, preface?: string): string {
	const body = safeBody(row.body);
	const lines: string[] = [];
	switch (row.kind) {
		case "task":
			lines.push(`[teams task ${body.task_id ?? ""}] from ${fromLabel}`.trim());
			if (preface) lines.push(preface);
			if (body.title) lines.push(`title: ${body.title}`);
			lines.push(`kind: ${body.kind ?? "-"}  difficulty: ${body.difficulty ?? "-"}${body.model ? `  model: ${body.model}` : ""}`);
			if (body.paths?.length) lines.push(`paths: ${body.paths.join(", ")}`);
			if (body.text) lines.push("", body.text);
			lines.push(
				"",
				`Reply with teams_report({ task_id: "${body.task_id ?? ""}", status: "done" | "blocked" | "progress", summary, sha? }).`,
			);
			break;
		case "cancel":
			lines.push(`[teams cancel] from ${fromLabel}: stop the current task now.`);
			if (body.text) lines.push("", body.text);
			break;
		case "ask":
			lines.push(`[teams ask] from ${fromLabel}:`);
			if (body.text) lines.push("", body.text);
			lines.push("", `Answer with teams_report({ status: "progress", summary }) or teams_ask back.`);
			break;
		case "report":
			lines.push(`[teams report] from ${fromLabel}: status=${body.status ?? "progress"}`);
			if (body.task_id) lines.push(`task: ${body.task_id}`);
			if (body.sha) lines.push(`sha: ${body.sha}`);
			if (body.summary) lines.push("", body.summary);
			break;
		case "answer":
			lines.push(`[teams answer] from ${fromLabel}:`);
			if (body.text) lines.push("", body.text);
			break;
		case "notice":
			lines.push("[teams notice]");
			if (body.text) lines.push("", body.text);
			break;
		default:
			lines.push(`[teams ${row.kind}] from ${fromLabel}:`);
			if (body.text ?? body.summary) lines.push("", (body.text ?? body.summary) as string);
	}
	return lines.join("\n");
}

/** Parsed body of a mail row; malformed JSON degrades to `{ text }`. */
export function mailBody(row: MailRow): MailBody {
	return safeBody(row.body);
}

function safeBody(raw: string): MailBody {
	try {
		const parsed: unknown = JSON.parse(raw);
		return typeof parsed === "object" && parsed !== null ? (parsed as MailBody) : {};
	} catch {
		return { text: raw };
	}
}

export class Mailer {
	constructor(
		private readonly db: Database,
		private readonly now: () => number = Date.now,
	) {}

	send(input: {
		fromAgent: string;
		fromSeat: string;
		toSeat: string;
		toAgent?: string | null;
		kind: MailKind;
		body: MailBody;
		taskId?: string | null;
	}): string {
		const id = `m-${shortId()}`;
		const at = this.now();
		this.db.run(
			`INSERT INTO messages (id, from_agent, from_seat, to_seat, to_agent, kind, wake, body, created_at, task_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				id,
				input.fromAgent,
				input.fromSeat,
				input.toSeat,
				input.toAgent ?? null,
				input.kind,
				wakeFor(input.kind, input.body) ? 1 : 0,
				JSON.stringify(input.body),
				at,
				input.taskId ?? input.body.task_id ?? null,
			],
		);
		logEvent(this.db, "mail:send", { kind: input.kind, toSeat: input.toSeat, msgId: id }, input.fromAgent, at);
		return id;
	}

	/** Undelivered messages addressed to this seat, oldest first. */
	inbox(seat: string, limit = 50): MailRow[] {
		return this.db
			.query("SELECT * FROM messages WHERE to_seat = ? AND delivered_at IS NULL ORDER BY created_at, rowid LIMIT ?")
			.all(seat, limit) as MailRow[];
	}

	markDelivered(ids: string[]): void {
		if (ids.length === 0) return;
		const at = this.now();
		const stmt = this.db.prepare("UPDATE messages SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL");
		const tx = this.db.transaction((values: string[]) => {
			for (const id of values) stmt.run(at, id);
		});
		tx(ids);
	}

	markAcked(ids: string[]): void {
		if (ids.length === 0) return;
		const at = this.now();
		const stmt = this.db.prepare("UPDATE messages SET acked_at = ?, delivered_at = COALESCE(delivered_at, ?) WHERE id = ?");
		const tx = this.db.transaction((values: string[]) => {
			for (const id of values) stmt.run(at, at, id);
		});
		tx(ids);
	}

	/**
	 * Latest reports addressed to a seat, newest first. Keyed by seat so a manager
	 * that replaced a crashed predecessor still sees what its reports said.
	 */
	recentReports(toSeat: string, limit = 200): MailRow[] {
		return this.db
			.query(
				`SELECT * FROM messages WHERE to_seat = ? AND kind IN ('report', 'answer')
				 ORDER BY created_at DESC, rowid DESC LIMIT ?`,
			)
			.all(toSeat, limit) as MailRow[];
	}
}

/**
 * Message ids already persisted in a session transcript.
 *
 * Used on session start: a message in history is acknowledged, so a restart
 * never re-delivers it.
 */
export function persistedMsgIds(entries: Iterable<{ type?: string; customType?: string; details?: unknown }>): string[] {
	const ids: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "custom_message" || entry.customType !== "teams-mail") continue;
		const details = entry.details;
		if (typeof details !== "object" || details === null || !("teamsMsgIds" in details)) continue;
		const value = details.teamsMsgIds;
		if (!Array.isArray(value)) continue;
		for (const id of value) if (typeof id === "string") ids.push(id);
	}
	return ids;
}
