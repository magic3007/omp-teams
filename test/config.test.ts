import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG, globMatch, mergeConfig, resolveModel } from "../src/config";

describe("configuration", () => {
	test("project overrides merge over personal defaults without mutating them", () => {
		const merged = mergeConfig(DEFAULT_CONFIG, {
			models: { routing: { default: "devin/claude-opus-5-5" } },
			limits: { max_workers_total: 7 },
		});
		expect(merged.models.routing.default).toBe("devin/claude-opus-5-5");
		// Sibling keys survive the merge.
		expect(merged.models.routing.by_kind.merge).toBe("deepseek/deepseek-flash");
		expect(merged.limits.max_workers_total).toBe(7);
		expect(merged.limits.workers_per_tab).toBe(DEFAULT_CONFIG.limits.workers_per_tab);
		expect(DEFAULT_CONFIG.models.routing.default).toBe("deepseek/deepseek-v4-flash");
	});

	test("worker default model is the routing default, not a role entry", () => {
		expect(DEFAULT_CONFIG.models.routing.default.length).toBeGreaterThan(0);
	});
});

describe("model routing", () => {
	const config = DEFAULT_CONFIG;

	test("kind wins over difficulty, difficulty wins over default", () => {
		expect(resolveModel(config, { kind: "test", difficulty: "hard" })).toEqual({
			model: "deepseek/deepseek-v4-flash",
			source: "by_kind",
		});
		expect(resolveModel(config, { difficulty: "hard" })).toEqual({
			model: "devin/claude-opus-5-5",
			source: "by_difficulty",
		});
		expect(resolveModel(config, { kind: "unmapped", difficulty: "unmapped" })).toEqual({
			model: "deepseek/deepseek-v4-flash",
			source: "default",
		});
	});

	test("an explicit model must be on the allow list", () => {
		expect(resolveModel(config, { model: "devin/claude-opus-5-5" })).toEqual({
			model: "devin/claude-opus-5-5",
			source: "explicit",
		});
		const rejected = resolveModel(config, { model: "some/expensive-model" });
		expect("error" in rejected).toBe(true);
		if (!("error" in rejected)) throw new Error("unreachable");
		expect(rejected.error).toContain("models.allowed");
	});

	test("path rules override the manager's own judgement", () => {
		const withRule = mergeConfig(config, {
			path_rules: [{ glob: "**/*.sql", kind: "merge" }],
		});
		expect(resolveModel(withRule, { kind: "refactor", difficulty: "hard", paths: ["db/schema.sql"] })).toEqual({
			model: "deepseek/deepseek-flash",
			source: "by_kind",
		});
		expect(resolveModel(withRule, { kind: "refactor", difficulty: "hard", paths: ["src/app.ts"] })).toEqual({
			model: "devin/claude-opus-5-5",
			source: "by_difficulty",
		});
	});

	test("a config with no routable model is an error, never a silent default", () => {
		const empty = mergeConfig(config, { models: { routing: { default: "" } } });
		const result = resolveModel(empty, { kind: "unmapped", difficulty: "unmapped" });
		expect("error" in result).toBe(true);
	});
});

describe("path globbing", () => {
	test("* stays inside one segment, ** crosses segments", () => {
		expect(globMatch("**/*.sql", "db/schema.sql")).toBe(true);
		expect(globMatch("**/*.sql", "a/b/c/schema.sql")).toBe(true);
		expect(globMatch("src/*.ts", "src/app.ts")).toBe(true);
		expect(globMatch("src/*.ts", "src/deep/app.ts")).toBe(false);
		expect(globMatch("**/*.sql", "db/schema.go")).toBe(false);
	});
});
