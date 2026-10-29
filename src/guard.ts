/**
 * Guards: the conditions under which the team must stop starting new work.
 *
 * Three brakes, all evaluated from the shared database so every member applies
 * the same answer:
 *   - `halt`: a human stopped the team (`/teams halt`).
 *   - `budget`: today's spend reached `guards.budget.daily_usd`.
 *   - `window`: the local clock is outside `guards.window` (or before
 *     `guards.quiet_until`).
 *
 * A brake stops new work: no assignment, no spawn, no worker claim. How much
 * each member has spent is self-reported through `ctx.sessionManager.
 * getUsageStatistics().cost`, upserted per session and day, because the model
 * prices live in the session, not in this extension.
 */
import type { Database } from "bun:sqlite";
import type { TeamsConfig } from "./config";

export interface GuardState {
	halted: boolean;
	haltReason: string | null;
	/** Today's spend, as reported by members. */
	spendToday: number;
	budgetUsd: number;
	frozen: boolean;
	/** Local clock is outside the allowed window, or before `quiet_until`. */
	outsideWindow: boolean;
	/** Why new work must not start, or null when it may. */
	stopReason: string | null;
}

const HALT_KEY = "halted";

/** Money for messages: cents are too coarse for a small budget, so small sums keep four digits. */
export function formatUsd(amount: number): string {
	return amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);
}

/** Local calendar day of `at`, `YYYY-MM-DD`; spend is summed per day. */
export function dayKey(at: number): string {
	const date = new Date(at);
	const month = `${date.getMonth() + 1}`.padStart(2, "0");
	const day = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function minutesOfDay(hhmm: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** Whether `now` is inside the configured working window (both ends inclusive). */
export function insideWindow(config: TeamsConfig, now: number): boolean {
	const date = new Date(now);
	const quietUntil = config.guards.quiet_until ? Date.parse(config.guards.quiet_until) : Number.NaN;
	if (Number.isFinite(quietUntil) && now < quietUntil) return false;
	const window = config.guards.window;
	if (!window) return true;
	const start = minutesOfDay(window.start);
	const end = minutesOfDay(window.end);
	if (start === null || end === null) return true;
	const minute = date.getHours() * 60 + date.getMinutes();
	// A window like 22:00–06:00 wraps around midnight.
	return start <= end ? minute >= start && minute <= end : minute >= start || minute <= end;
}

export function readState(db: Database, key: string): string | null {
	const row = db.query("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | null;
	return row?.value ?? null;
}

export function setState(db: Database, key: string, value: string | null, at = Date.now()): void {
	if (value === null) {
		db.run("DELETE FROM state WHERE key = ?", [key]);
		return;
	}
	db.run(
		"INSERT INTO state (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
		[key, value, at],
	);
}

export function haltReason(db: Database): string | null {
	return readState(db, HALT_KEY);
}

export function spendToday(db: Database, at = Date.now()): number {
	const row = db.query("SELECT COALESCE(SUM(cost), 0) AS total FROM usage WHERE day = ?").get(dayKey(at)) as { total: number } | null;
	return row?.total ?? 0;
}

/** USD per million tokens for `model`: exact match, then `provider/*`, then `*`. */
export function priceFor(config: TeamsConfig, model: string | null): { input: number; output: number } {
	const prices = config.guards.budget.prices;
	if (!model) return prices["*"] ?? { input: 0, output: 0 };
	const provider = model.includes("/") ? `${model.split("/")[0]}/` : "";
	return prices[model] ?? (provider ? prices[`${provider}*`] : undefined) ?? prices["*"] ?? { input: 0, output: 0 };
}

/** What a session's tokens are worth when the provider reports no cost. */
export function estimateCost(config: TeamsConfig, model: string | null, tokens: { input: number; output: number }): number {
	const price = priceFor(config, model);
	return (tokens.input * price.input + tokens.output * price.output) / 1_000_000;
}

export interface SpendInput {
	sessionId: string;
	agentId: string | null;
	seat: string;
	model: string | null;
	/** Cost the session itself reports; 0 when the provider has no price table. */
	cost: number;
	tokens?: { input: number; output: number };
	/** Used to price tokens when `cost` is 0. */
	config?: TeamsConfig;
	at?: number;
}

/**
 * Record a member's session spend; the row keeps the highest figures seen for
 * that session and day. A reported cost wins; otherwise the tokens are priced
 * with the configured table, so the budget still has a meaning on providers
 * that report no price at all.
 */
export function recordSpend(db: Database, input: SpendInput): number {
	const at = input.at ?? Date.now();
	const tokens = input.tokens ?? { input: 0, output: 0 };
	const reported = Number.isFinite(input.cost) && input.cost > 0 ? input.cost : 0;
	const cost = reported > 0 ? reported : input.config ? estimateCost(input.config, input.model, tokens) : 0;
	db.run(
		`INSERT INTO usage (session_id, day, agent_id, seat, model, cost, input_tokens, output_tokens, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(session_id, day) DO UPDATE SET cost = MAX(usage.cost, excluded.cost),
			input_tokens = MAX(usage.input_tokens, excluded.input_tokens),
			output_tokens = MAX(usage.output_tokens, excluded.output_tokens),
			at = excluded.at, agent_id = excluded.agent_id`,
		[input.sessionId, dayKey(at), input.agentId, input.seat, input.model, cost, tokens.input, tokens.output, at],
	);
	return cost;
}

/** Current brake state. `config` decides the limits; the database holds halt and spend. */
export function guardState(db: Database, config: TeamsConfig, now = Date.now()): GuardState {
	const halted = haltReason(db);
	const spend = spendToday(db, now);
	const budgetUsd = config.guards.budget.daily_usd;
	const frozen = budgetUsd > 0 && spend >= budgetUsd;
	const outside = !insideWindow(config, now);
	const stopReason = halted
		? `the team is halted: ${halted}`
		: frozen
			? `the daily budget is spent ($${formatUsd(spend)} of $${formatUsd(budgetUsd)}); raise guards.budget.daily_usd or wait for tomorrow`
			: outside
				? "the clock is outside the allowed working window (guards.window / guards.quiet_until)"
				: null;
	return { halted: halted !== null, haltReason: halted, spendToday: spend, budgetUsd, frozen, outsideWindow: outside, stopReason };
}
