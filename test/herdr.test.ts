import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Herdr, herdrAvailable, metadataArgs } from "../src/herdr";
import { decodeJoin, encodeJoin, launcherScript } from "../src/spawn";

let home: string;
let stub: string;
const calls: string[] = [];

const RESPONSES: Record<string, string> = {
	"workspace create": JSON.stringify({
		id: "cli:workspace:create",
		result: {
			workspace: { workspace_id: "wXX", label: "repo" },
			tab: { tab_id: "wXX:t1" },
			root_pane: { pane_id: "wXX:p1", tab_id: "wXX:t1", workspace_id: "wXX", cwd: "/repo" },
		},
	}),
	"tab create": JSON.stringify({
		id: "cli:tab:create",
		result: {
			tab: { tab_id: "wXX:t2" },
			root_pane: { pane_id: "wXX:p2", tab_id: "wXX:t2", workspace_id: "wXX", cwd: "/wt" },
		},
	}),
	"pane split": JSON.stringify({
		id: "cli:pane:split",
		result: { pane: { pane_id: "wXX:p3", tab_id: "wXX:t2", workspace_id: "wXX", cwd: "/wt" } },
	}),
	"tab rename": JSON.stringify({ id: "cli:tab:rename", result: { type: "ok" } }),
	"pane run": JSON.stringify({ id: "cli:pane:run", result: { type: "ok" } }),
	"pane rename": JSON.stringify({ id: "cli:pane:rename", result: { type: "ok" } }),
	"workspace rename": JSON.stringify({ id: "cli:workspace:rename", result: { type: "ok" } }),
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-teams-herdr-"));
	stub = join(home, "herdr");
	calls.length = 0;
	const script = [
		"#!/bin/sh",
		`echo "$@" >> ${join(home, "calls.log")}`,
		'case "$*" in *--stub-fail*) echo "boom" >&2; exit 7 ;; esac',
		'key="$1 $2"',
		"case \"$key\" in",
		...Object.keys(RESPONSES).map(
			(pattern) => `  "${pattern}") printf '%s' '${RESPONSES[pattern]?.replace(/'/g, `'\\''`)}' ;;`,
		),
		'  "pane report-metadata") printf \'%s\' \'{"id":"x","result":{"type":"ok"}}\' ;;',
		'  "pane list") printf \'%s\' \'{"result":{"panes":[{"pane_id":"wXX:p1","tab_id":"wXX:t1","workspace_id":"wXX","cwd":"/repo","display_agent":"★ personal"}]}}\' ;;',
		'  *) printf \'%s\' \'{"error":{"code":"unknown","message":"no stub"}}\' ;;',
		"esac",
	].join("\n");
	writeFileSync(stub, `${script}\n`);
	chmodSync(stub, 0o755);
	process.env.HERDR_BIN_PATH = stub;
	process.env.HERDR_ENV = "1";
	process.env.HERDR_SOCKET_PATH = "/tmp/fake.sock";
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	delete process.env.HERDR_BIN_PATH;
});

function recordedCalls(): string[] {
	try {
		return readFileSync(join(home, "calls.log"), "utf8").trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

describe("herdr adapter", () => {
	test("availability needs a herdr pane environment", () => {
		expect(herdrAvailable()).toBe(true);
		delete process.env.HERDR_ENV;
		expect(herdrAvailable()).toBe(false);
		process.env.HERDR_ENV = "1";
	});

	test("workspace creation returns the workspace, tab and root pane", () => {
		const result = new Herdr().createWorkspace("/repo", "repo");
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error(result.error);
		expect(result.value).toEqual({ workspaceId: "wXX", tabId: "wXX:t1", paneId: "wXX:p1" });
		expect(recordedCalls()[0]).toContain("workspace create --cwd /repo --label repo --no-focus");
	});

	test("tab creation and pane splitting land in the same workspace", () => {
		const tab = new Herdr().createTab("wXX", "/wt", "◆ lead·feat-x");
		expect(tab.ok && tab.value.paneId).toBe("wXX:p2");
		const split = new Herdr().splitPane("wXX:p2", "/wt/w1", "right");
		expect(split.ok && split.value.paneId).toBe("wXX:p3");
		expect(recordedCalls().join("\n")).toContain("--no-focus");
	});

	test("metadata is reported with the omp-teams source, labels and tokens", () => {
		const args = metadataArgs("wXX:p1", {
			displayAgent: "w1·feat-x",
			stateLabels: { working: "▶ T-1" },
			tokens: { role: "worker" },
			seq: 3,
			ttlMs: 90_000,
		});
		expect(args).toEqual([
			"pane",
			"report-metadata",
			"wXX:p1",
			"--source",
			"omp-teams",
			"--display-agent",
			"w1·feat-x",
			"--state-label",
			"working=▶ T-1",
			"--token",
			"role=worker",
			"--seq",
			"3",
			"--ttl-ms",
			"90000",
		]);
	});

	test("presence updates do not block on herdr", async () => {
		new Herdr().reportPresence("wXX:p1", { displayAgent: "w1·feat-x" }, "w1·feat-x: task");
		for (let i = 0; i < 40 && recordedCalls().length < 2; i++) await Bun.sleep(25);
		const calls = recordedCalls().join("\n");
		expect(calls).toContain("pane report-metadata wXX:p1 --source omp-teams --display-agent w1·feat-x");
		expect(calls).toContain("pane rename wXX:p1 w1·feat-x: task");
	});

	test("pane run succeeds with an empty body and fails on a non-zero exit", () => {
		expect(new Herdr().runInPane("wXX:p1", "echo hi").ok).toBe(true);
		const missing = new Herdr().runInPane("wXX:p1", "--stub-fail");
		expect(missing.ok).toBe(false);
	});

	test("pane listing parses display metadata", () => {
		const panes = new Herdr().listPanes();
		expect(panes.ok).toBe(true);
		if (!panes.ok) throw new Error(panes.error);
		expect(panes.value[0]?.display_agent).toBe("★ personal");
	});

	test("a herdr error is surfaced, not swallowed", () => {
		const result = new Herdr().closeWorkspace("wXX");
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.error).toContain("herdr");
	});
});

describe("join contract", () => {
	test("round-trips role, group and slot", () => {
		const encoded = encodeJoin({ role: "worker", group: "feat-x", slot: "s-1234" });
		expect(encoded).toBe("role=worker group=feat-x slot=s-1234");
		expect(decodeJoin(encoded)).toEqual({ role: "worker", group: "feat-x", slot: "s-1234" });
	});

	test("undefined fields are omitted and whitespace cannot break parsing", () => {
		const encoded = encodeJoin({ role: "group", project: undefined, group: "a b" });
		expect(encoded).toBe("role=group group=a_b");
		expect(decodeJoin(encoded).group).toBe("a_b");
	});

	test("the launcher pins the teams home, the join string and the worktree", () => {
		const script = launcherScript({
			home: "/home/u/.omp/teams",
			cwd: "/wt/feat-x/w1",
			join: "role=worker group=feat-x slot=s-1",
			model: "deepseek/deepseek-v4-flash",
			maxCostUsd: 50,
			tag: "slot-s-1",
		});
		expect(script).toContain("export OMP_TEAMS_HOME='/home/u/.omp/teams'");
		expect(script).toContain("export OMP_TEAMS_JOIN='role=worker group=feat-x slot=s-1'");
		expect(script).toContain("cd '/wt/feat-x/w1'");
		expect(script).toContain("omp --model 'deepseek/deepseek-v4-flash' --max-cost 50");
		expect(script).toContain("export OMP_TEAMS_STOP='/home/u/.omp/teams/launch/slot-s-1.stop'");
	});

	test("single quotes in a path are escaped instead of breaking the script", () => {
		const script = launcherScript({
			home: "/home/o'brien/teams",
			cwd: "/tmp",
			join: "role=personal",
			model: "m",
			tag: "personal",
		});
		expect(script).toContain(`export OMP_TEAMS_HOME='/home/o'\\''brien/teams'`);
	});
});
