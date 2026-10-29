import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandPath, parseArgs } from "../src/commands";

describe("command arguments", () => {
	test("positional words and flags with or without values", () => {
		expect(parseArgs("spawn worker --count 2")).toEqual({ positional: ["spawn", "worker"], flags: { count: "2" } });
		expect(parseArgs("tree --all --text")).toEqual({ positional: ["tree"], flags: { all: true, text: true } });
		expect(parseArgs("")).toEqual({ positional: [], flags: {} });
		expect(parseArgs("  assign   queue  feature  hard  fix the parser ")).toEqual({
			positional: ["assign", "queue", "feature", "hard", "fix", "the", "parser"],
			flags: {},
		});
	});

	test("a flag never swallows the next flag as its value", () => {
		expect(parseArgs("progress --fresh --hours 6")).toEqual({ positional: ["progress"], flags: { fresh: true, hours: "6" } });
	});

	test("home-relative paths expand, other paths resolve", () => {
		expect(expandPath("~")).toBe(homedir());
		expect(expandPath("~/code/team")).toBe(join(homedir(), "code/team"));
		expect(expandPath("code/team")).toBe(join(process.cwd(), "code/team"));
	});
});
