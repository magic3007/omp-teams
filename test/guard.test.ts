import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { DEFAULT_CONFIG, mergeConfig, type TeamsConfig } from "../src/config";
import { openDb } from "../src/db";
import { dayKey, guardState, haltReason, insideWindow, priceFor, recordSpend, setState, spendToday } from "../src/guard";

let home: string;
let db: Database;

function config(overrides: unknown): TeamsConfig {
	return mergeConfig(DEFAULT_CONFIG, overrides);
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-teams-guard-"));
	db = openDb(home);
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("guards", () => {
	test("nothing stops work out of the box", () => {
		const state = guardState(db, config({}));
		expect(state.stopReason).toBeNull();
		expect(state.frozen).toBe(false);
		expect(state.halted).toBe(false);
	});

	test("a halt stops new work everywhere until it is lifted", () => {
		setState(db, "halted", "lunch break", 1_000);
		expect(haltReason(db)).toBe("lunch break");
		const state = guardState(db, config({}));
		expect(state.halted).toBe(true);
		expect(state.stopReason).toContain("halted: lunch break");
		setState(db, "halted", null);
		expect(haltReason(db)).toBeNull();
		expect(guardState(db, config({})).stopReason).toBeNull();
	});

	test("spend for the day decides whether the budget is spent", () => {
		const now = new Date("2026-10-29T10:00:00").getTime();
		recordSpend(db, { sessionId: "s-1", agentId: "a-1", seat: "worker:s-1", model: "m", cost: 1.5, at: now });
		recordSpend(db, { sessionId: "s-2", agentId: "a-2", seat: "worker:s-2", model: "m", cost: 0.5, at: now });
		// Yesterday does not count.
		recordSpend(db, { sessionId: "s-3", agentId: "a-3", seat: "worker:s-3", model: "m", cost: 9, at: now - 24 * 60 * 60_000 });
		expect(spendToday(db, now)).toBeCloseTo(2, 5);

		expect(guardState(db, config({ guards: { budget: { daily_usd: 5 } } }), now).frozen).toBe(false);
		const broke = guardState(db, config({ guards: { budget: { daily_usd: 2 } } }), now);
		expect(broke.frozen).toBe(true);
		expect(broke.stopReason).toContain("daily budget is spent ($2.00 of $2.00)");
		expect(broke.spendToday).toBeCloseTo(2, 5);
	});

	test("a session's spend only grows: the ledger keeps the highest figure", () => {
		const now = Date.now();
		recordSpend(db, { sessionId: "s-1", agentId: "a-1", seat: "worker:s-1", model: null, cost: 3, at: now });
		recordSpend(db, { sessionId: "s-1", agentId: "a-1", seat: "worker:s-1", model: null, cost: 1, at: now });
		expect(spendToday(db, now)).toBeCloseTo(3, 5);
		recordSpend(db, { sessionId: "s-1", agentId: "a-1", seat: "worker:s-1", model: null, cost: 4.5, at: now });
		expect(spendToday(db, now)).toBeCloseTo(4.5, 5);
	});

	test("the window allows every hour unless configured, and wraps past midnight", () => {
		const at = (hhmm: string): number => new Date(`2026-10-29T${hhmm}:00`).getTime();
		expect(insideWindow(config({}), at("03:00"))).toBe(true);
		const night = config({ guards: { window: { start: "22:00", end: "06:00" } } });
		expect(insideWindow(night, at("23:30"))).toBe(true);
		expect(insideWindow(night, at("02:00"))).toBe(true);
		expect(insideWindow(night, at("06:00"))).toBe(true);
		expect(insideWindow(night, at("12:00"))).toBe(false);
		expect(guardState(db, night, at("12:00")).stopReason).toContain("outside the allowed working window");
	});

	test("quiet_until keeps the team idle until that moment", () => {
		const quietUntil = "2026-10-29T07:00:00";
		const cfg = config({ guards: { quiet_until: quietUntil } });
		expect(guardState(db, cfg, new Date("2026-10-29T06:59:00").getTime()).stopReason).toContain("outside the allowed working window");
		expect(guardState(db, cfg, new Date("2026-10-29T07:01:00").getTime()).stopReason).toBeNull();
	});

	test("dayKey is the local calendar day", () => {
		expect(dayKey(new Date("2026-01-02T23:30:00").getTime())).toBe("2026-01-02");
	});
});

describe("pricing when a provider reports no cost", () => {
	const priced = config({ guards: { budget: { daily_usd: 5, prices: { "deepseek/deepseek-flash": { input: 2, output: 8 }, "deepseek/*": { input: 1, output: 1 }, "*": { input: 10, output: 30 } } } } });

	test("an exact model price wins over a provider wildcard and the fallback", () => {
		expect(priceFor(priced, "deepseek/deepseek-flash")).toEqual({ input: 2, output: 8 });
		expect(priceFor(priced, "deepseek/other")).toEqual({ input: 1, output: 1 });
		expect(priceFor(priced, "someone/else")).toEqual({ input: 10, output: 30 });
		expect(priceFor(priced, null)).toEqual({ input: 10, output: 30 });
	});

	test("tokens are priced when the session reports zero cost", () => {
		const now = Date.now();
		const cost = recordSpend(db, {
			sessionId: "s-1",
			agentId: "a-1",
			seat: "worker:s-1",
			model: "deepseek/deepseek-flash",
			cost: 0,
			tokens: { input: 1_000_000, output: 500_000 },
			config: priced,
			at: now,
		});
		expect(cost).toBeCloseTo(2 + 4, 5);
		expect(spendToday(db, now)).toBeCloseTo(6, 5);
	});

	test("a reported cost is used as is, even when it disagrees with the table", () => {
		const now = Date.now();
		const cost = recordSpend(db, {
			sessionId: "s-2",
			agentId: "a-2",
			seat: "worker:s-2",
			model: "deepseek/deepseek-flash",
			cost: 0.25,
			tokens: { input: 1_000_000, output: 1_000_000 },
			config: priced,
			at: now,
		});
		expect(cost).toBeCloseTo(0.25, 5);
	});
});
