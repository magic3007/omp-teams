import type { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dayKey, formatUsd } from "./guard";
import { git, sessionTag } from "./identity";

export interface ReportInput {
	db: Database;
	home: string;
	now: number;
	budgetUsd: number;
	spendUsd: number;
	haltReason: string | null;
	projectRoot: (projectId: string | null) => string | null;
}

interface GroupLine {
	project: string;
	root: string | null;
	group: string;
	branch: string;
	worktree: string;
	head: string | null;
	base: string | null;
	ahead: number;
	files: string[];
	conflict: boolean;
	done: number;
	blocked: number;
	workers: number;
	paused: string | null;
}

function groupsOf(db: Database, projectRoot: (id: string | null) => string | null): GroupLine[] {
	const groups = db
		.query(
			`SELECT g.project_id, g.name, g.branch, g.worktree, g.base, g.head_sha, g.paused, g.paused_reason, p.name AS project
			 FROM groups g JOIN projects p ON p.id = g.project_id ORDER BY p.name, g.name`,
		)
		.all() as {
		project_id: string;
		project: string;
		name: string;
		branch: string;
		worktree: string;
		base: string | null;
		head_sha: string | null;
		paused: number;
		paused_reason: string | null;
	}[];
	return groups.map((group) => {
		const base = group.base ?? "main";
		const root = projectRoot(group.project_id);
		const head = git(group.worktree, ["rev-parse", "HEAD"]);
		const ahead = Number(git(group.worktree, ["rev-list", "--count", `${base}..HEAD`]) ?? "0");
		const changed = git(group.worktree, ["diff", "--name-status", `${base}...HEAD`]);
		const tree = git(group.worktree, ["merge-tree", git(group.worktree, ["merge-base", base, "HEAD"]) ?? base, base, "HEAD"]);
		const counts = db
			.query(
				`SELECT status, COUNT(*) AS n FROM tasks WHERE project_id = ? AND group_name = ? AND kind != 'merge' GROUP BY status`,
			)
			.all(group.project_id, group.name) as { status: string; n: number }[];
		const countOf = (status: string): number => counts.find((row) => row.status === status)?.n ?? 0;
		const workers = db
			.query(
				`SELECT COUNT(*) AS n FROM agents a JOIN slots s ON a.seat = 'worker:' || s.id
				 WHERE a.status = 'alive' AND a.group_name = ? AND s.kind = 'worker'`,
			)
			.get(group.name) as { n: number };
		return {
			project: group.project,
			root,
			group: group.name,
			branch: group.branch,
			worktree: group.worktree,
			head,
			base,
			ahead: Number.isFinite(ahead) ? ahead : 0,
			files: (changed ?? "")
				.split("\n")
				.filter(Boolean)
				.map((line) => line.replace(/\t+/g, " ")),
			conflict: (tree ?? "").includes("changed in both") || (tree ?? "").includes("CONFLICT"),
			done: countOf("done"),
			blocked: countOf("blocked"),
			workers: workers.n,
			paused: group.paused ? (group.paused_reason ?? "paused by a human") : null,
		};
	});
}

function blockers(db: Database, now: number): { id: string; title: string; summary: string; at: number }[] {
	const rows = db
		.query(
			`SELECT t.id, t.title, t.updated_at AS at,
				(SELECT m.body FROM messages m WHERE m.task_id = t.id AND m.kind = 'report'
				 AND json_extract(m.body, '$.status') = 'blocked' ORDER BY m.created_at DESC LIMIT 1) AS body
			 FROM tasks t WHERE t.status = 'blocked' ORDER BY t.updated_at DESC LIMIT 20`,
		)
		.all() as { id: string; title: string; at: number; body: string | null }[];
	return rows.map((row) => {
		let summary = "";
		try {
			summary = String((JSON.parse(row.body ?? "{}") as { summary?: unknown }).summary ?? "");
		} catch {
			summary = row.body ?? "";
		}
		return { id: row.id, title: row.title, at: row.at, summary: summary.replace(/\s+/g, " ").slice(0, 300) };
	});
}

function usageLines(db: Database, day: string): { seat: string; model: string | null; cost: number }[] {
	return db
		.query("SELECT seat, model, cost FROM usage WHERE day = ? ORDER BY cost DESC")
		.all(day) as { seat: string; model: string | null; cost: number }[];
}

function members(db: Database): { label: string; session: string; file: string | null }[] {
	const rows = db
		.query("SELECT label, session_id, session_file FROM agents WHERE status = 'alive' ORDER BY label")
		.all() as { label: string; session_id: string; session_file: string | null }[];
	const pool = rows.map((row) => row.session_id);
	return rows.map((row) => ({ label: row.label, session: sessionTag(row.session_id, pool), file: row.session_file }));
}

export function writeDailyReport(input: ReportInput): { markdown: string; path: string } {
	const { db, home, now } = input;
	const day = dayKey(now);
	const lines: string[] = [`# omp-teams 日报 ${day}`, ""];
	const stamp = new Date(now).toLocaleString();
	lines.push(`生成时间：${stamp}`);
	lines.push(
		`花费：$${formatUsd(input.spendUsd)} / $${formatUsd(input.budgetUsd)}${input.haltReason ? ` · 已停止：${input.haltReason}` : ""}`,
		"",
	);

	const groups = groupsOf(db, input.projectRoot);
	lines.push("## 分支", "", "| 项目 | group | 分支 | head | 领先 base | 改动文件 | 完成 | blocked | worker | 状态 |", "|---|---|---|---|---|---|---|---|---|---|");
	for (const group of groups) {
		lines.push(
			`| ${group.project} | ${group.group} | \`${group.branch}\` | ${group.head?.slice(0, 12) ?? "-"} | ${group.ahead} | ${
				group.files.length === 0 ? "无" : group.files.join("<br>")
			} | ${group.done} | ${group.blocked} | ${group.workers} | ${group.paused ?? "运行中"} |`,
		);
	}
	if (groups.length === 0) lines.push("| - | - | - | - | - | - | - | - | - | - |");
	lines.push("");

	const blocked = blockers(db, now);
	lines.push("## 需要人决定", "");
	if (blocked.length === 0) lines.push("无。");
	for (const task of blocked) lines.push(`- \`${task.id}\` ${task.title.slice(0, 90)} — ${task.summary || "（无说明）"}`);
	lines.push("");

	lines.push("## 合并", "");
	const withWork = groups.filter((group) => group.ahead > 0);
	if (withWork.length === 0) lines.push("没有待合并的分支。");
	for (const group of withWork) {
		lines.push(
			`- \`${group.branch}\`（${group.project}，领先 ${group.base} ${group.ahead} 个提交${group.conflict ? "，**预演有冲突**" : ""}）`,
		);
		const mergeLine = group.root
			? `git -C ${group.root} merge --no-ff ${group.branch}`
			: `git -C <${group.project} 的主仓库> merge --no-ff ${group.branch}`;
		lines.push("  ```sh", `  ${mergeLine}`, "  ```");
	}
	lines.push("");

	const spend = usageLines(db, day);
	lines.push("## 花费", "");
	if (spend.length === 0) lines.push("无记录。");
	for (const row of spend) lines.push(`- ${row.seat}${row.model ? ` (${row.model})` : ""}: $${row.cost.toFixed(4)}`);
	lines.push("");

	lines.push("## 钻取", "");
	for (const member of members(db)) {
		lines.push(`- ${member.label} — \`omp -r ${member.session}\`${member.file ? ` · ${member.file}` : ""}`);
	}
	lines.push("");

	const markdown = lines.join("\n");
	const dir = join(home, "reports");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, `${day}.md`);
	writeFileSync(path, markdown);
	return { markdown, path };
}

export interface AuditInput {
	db: Database;
	home: string;
	now: number;
	since: number;
}

export function writeAudit(input: AuditInput): { path: string; counts: Record<string, number> } {
	const { db, home, now, since } = input;
	const select = (sql: string, ...params: (string | number)[]): unknown[] => db.query(sql).all(...params);
	const audit = {
		generated_at: new Date(now).toISOString(),
		since: new Date(since).toISOString(),
		projects: select("SELECT * FROM projects"),
		groups: select("SELECT * FROM groups"),
		agents: select("SELECT * FROM agents WHERE registered_at >= ? ORDER BY registered_at", since),
		slots: select("SELECT * FROM slots"),
		tasks: select("SELECT * FROM tasks WHERE created_at >= ? ORDER BY created_at", since),
		messages: select("SELECT * FROM messages WHERE created_at >= ? ORDER BY created_at", since),
		events: select("SELECT * FROM events WHERE at >= ? ORDER BY id", since),
		usage: select("SELECT * FROM usage ORDER BY day, at"),
		state: select("SELECT key, value, updated_at FROM state"),
	};
	const counts: Record<string, number> = {};
	for (const [key, value] of Object.entries(audit)) if (Array.isArray(value)) counts[key] = value.length;
	const dir = join(home, "exports");
	mkdirSync(dir, { recursive: true });
	const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
	const path = join(dir, `audit-${stamp}.json`);
	writeFileSync(path, `${JSON.stringify(audit, null, 2)}\n`);
	return { path, counts };
}

export function sinceFromHours(hours: number, now: number): number {
	return now - Math.max(0, hours) * 60 * 60_000;
}
