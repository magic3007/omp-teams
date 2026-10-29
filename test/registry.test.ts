import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { openDb } from "../src/db";
import { Registry } from "../src/registry";

let home: string;
let db: Database;
let clock: number;
let registry: Registry;

const DEAD_AFTER = 30_000;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "omp-teams-reg-"));
	db = openDb(home);
	clock = 1_000_000;
	registry = new Registry(db, { deadAfterMs: DEAD_AFTER, now: () => clock });
});

afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
});

describe("registry", () => {
	test("personal manager is unique and a live holder blocks a second session", () => {
		const first = registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		expect(first.ok).toBe(true);

		const second = registry.register({ role: "personal", cwd: "/home/y", sessionId: "s2" });
		expect(second.ok).toBe(false);
		if (second.ok) throw new Error("unreachable");
		expect(second.error).toContain("already held by");
		expect(second.error).toContain("★★★ personal leader");
	});

	test("a seat whose holder stopped heartbeating can be taken over", () => {
		registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		clock += DEAD_AFTER + 1;

		const takeover = registry.register({ role: "personal", cwd: "/home/y", sessionId: "s2" });
		expect(takeover.ok).toBe(true);
		if (!takeover.ok) throw new Error("unreachable");
		expect(takeover.agent.session_id).toBe("s2");
		expect(takeover.created).toBe(true);
		expect(registry.bySeat("personal")?.session_id).toBe("s2");
	});

	test("re-registering the same session updates its row instead of conflicting", () => {
		const first = registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		expect(first.ok).toBe(true);
		clock += 5_000;
		const again = registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		expect(again.ok).toBe(true);
		if (!again.ok) throw new Error("unreachable");
		expect(again.created).toBe(false);
		if (first.ok) expect(again.agent.id).toBe(first.agent.id);
		expect(again.agent.last_seen).toBe(clock);
	});

	test("a session cannot switch roles without leaving first", () => {
		registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		const other = registry.register({
			role: "project",
			cwd: "/repo",
			sessionId: "s1",
			projectId: "p-1",
			projectName: "repo",
		});
		expect(other.ok).toBe(false);
		if (other.ok) throw new Error("unreachable");
		expect(other.error).toContain("/teams leave");
	});

	test("a missing parent is refused with the next command to run", () => {
		const project = registry.register({
			role: "project",
			cwd: "/repo",
			sessionId: "s1",
			projectId: "p-1",
			projectName: "repo",
		});
		expect(project.ok).toBe(false);
		if (project.ok) throw new Error("unreachable");
		expect(project.error).toContain("parent personal is not registered");
		expect(project.error).toContain("/teams personal");
	});

	test("full chain: personal -> project -> group -> worker", () => {
		expect(registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" }).ok).toBe(true);
		const project = registry.register({
			role: "project",
			cwd: "/repo",
			sessionId: "s2",
			projectId: "p-1",
			projectName: "repo",
		});
		expect(project.ok).toBe(true);
		const group = registry.register({
			role: "group",
			cwd: "/repo",
			sessionId: "s3",
			projectId: "p-1",
			projectName: "repo",
			group: "feat-x",
		});
		expect(group.ok).toBe(true);
		const worker = registry.register({
			role: "worker",
			cwd: "/wt/feat-x/w1",
			sessionId: "s4",
			projectId: "p-1",
			projectName: "repo",
			group: "feat-x",
			slotId: "s-w1",
			index: 1,
		});
		expect(worker.ok).toBe(true);
		if (!worker.ok) throw new Error("unreachable");

		expect(worker.agent.parent_seat).toBe("group:p-1/feat-x");
		expect(worker.agent.label).toBe("☆ worker 1 · feat-x");

		const personal = registry.bySeat("personal");
		expect(personal).not.toBeNull();
		if (!personal) throw new Error("unreachable");
		expect(registry.childrenOf(personal.seat).map((row) => row.role)).toEqual(["project"]);
	});

	test("visibility: worker sees parent and peers, not other groups", () => {
		registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		registry.register({ role: "project", cwd: "/repo", sessionId: "s2", projectId: "p-1", projectName: "repo" });
		registry.register({
			role: "group",
			cwd: "/repo",
			sessionId: "s3",
			projectId: "p-1",
			projectName: "repo",
			group: "feat-x",
		});
		registry.register({
			role: "group",
			cwd: "/repo",
			sessionId: "s4",
			projectId: "p-1",
			projectName: "repo",
			group: "fix-y",
			slotId: "s-w3",
			index: 1,
		});
		const w1 = registry.register({
			role: "worker",
			cwd: "/wt/feat-x/w1",
			sessionId: "s5",
			projectId: "p-1",
			projectName: "repo",
			group: "feat-x",
			slotId: "s-w1",
			index: 1,
		});
		const w2 = registry.register({
			role: "worker",
			cwd: "/wt/feat-x/w2",
			sessionId: "s6",
			projectId: "p-1",
			projectName: "repo",
			group: "feat-x",
			slotId: "s-w2",
			index: 2,
		});
		registry.register({
			role: "worker",
			cwd: "/wt/fix-y/w1",
			sessionId: "s7",
			projectId: "p-1",
			projectName: "repo",
			group: "fix-y",
			slotId: "s-w3",
			index: 1,
		});
		if (!w1.ok || !w2.ok) throw new Error("unreachable");

		const visible = registry.visibleTo(w1.agent).map((row) => row.label);
		expect(visible).toContain("★ group leader · feat-x");
		expect(visible).toContain("☆ worker 2 · feat-x");
		expect(visible).not.toContain("★ group leader · fix-y");
		expect(visible).not.toContain("☆ worker 1 · fix-y");
		expect(visible).not.toContain("★★★ personal leader");

		expect(registry.resolveRef(w1.agent, "parent")?.label).toBe("★ group leader · feat-x");
		expect(registry.resolveRef(w1.agent, "worker 2")?.label).toBe("☆ worker 2 · feat-x");
		expect(registry.resolveRef(w1.agent, "personal")).toBeNull();
	});

	test("a member marked dead while still running takes its seat back, unless someone else holds it", () => {
		const first = registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		if (!first.ok) throw new Error(first.error);
		clock += DEAD_AFTER + 1;
		registry.sweepDead();
		expect(registry.bySeat("personal")).toBeNull();

		const revived = registry.revive(first.agent.id);
		expect(revived?.status).toBe("alive");
		expect(registry.bySeat("personal")?.session_id).toBe("s1");

		clock += DEAD_AFTER + 1;
		registry.sweepDead();
		const second = registry.register({ role: "personal", cwd: "/home/y", sessionId: "s2" });
		expect(second.ok).toBe(true);
		expect(registry.revive(first.agent.id)).toBeNull();
		expect(registry.bySeat("personal")?.session_id).toBe("s2");
	});

	test("a member that left is never revived", () => {
		const first = registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		if (!first.ok) throw new Error(first.error);
		registry.markStatus(first.agent.id, "left");
		expect(registry.revive(first.agent.id)).toBeNull();
	});

	test("sweepDead marks silent members dead and keeps attending ones alive", () => {
		registry.register({ role: "personal", cwd: "/home/x", sessionId: "s1" });
		const project = registry.register({
			role: "project",
			cwd: "/repo",
			sessionId: "s2",
			projectId: "p-1",
			projectName: "repo",
		});
		if (!project.ok) throw new Error("unreachable");

		clock += DEAD_AFTER - 1_000;
		registry.heartbeat(project.agent.id);
		clock += 2_000;

		const dead = registry.sweepDead();
		expect(dead.map((row) => row.session_id)).toEqual(["s1"]);
		expect(registry.bySeat("personal")).toBeNull();
		expect(registry.bySeat("project:p-1")?.session_id).toBe("s2");
	});
});
