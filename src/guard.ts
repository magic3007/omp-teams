import type { Database } from "bun:sqlite";
import type { TeamsConfig } from "./config";

export interface GuardState {
	halted: boolean;
	haltReason: string | null;
	spendToday: number;
	budgetUsd: number;
	frozen: boolean;
	outsideWindow: boolean;
	stopReason: string | null;
}

const HALT_KEY = "halted";

export function formatUsd(amount: number): string {
	return amount >= 1 ? amount.toFixed(2) : amount.toFixed(4);
}

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

export function priceFor(config: TeamsConfig, model: string | null): { input: number; output: number } {
	const prices = config.guards.budget.prices;
	if (!model) return prices["*"] ?? { input: 0, output: 0 };
	const provider = model.includes("/") ? `${model.split("/")[0]}/` : "";
	return prices[model] ?? (provider ? prices[`${provider}*`] : undefined) ?? prices["*"] ?? { input: 0, output: 0 };
}

export function estimateCost(config: TeamsConfig, model: string | null, tokens: { input: number; output: number }): number {
	const price = priceFor(config, model);
	return (tokens.input * price.input + tokens.output * price.output) / 1_000_000;
}

export interface SpendInput {
	sessionId: string;
	agentId: string | null;
	seat: string;
	model: string | null;
	cost: number;
	tokens?: { input: number; output: number };
	config?: TeamsConfig;
	at?: number;
}

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
