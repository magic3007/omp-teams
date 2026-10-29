import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCHEMA_VERSION = 8;

export function teamsHome(): string {
	return process.env.OMP_TEAMS_HOME ?? join(homedir(), ".omp", "teams");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
	id            TEXT PRIMARY KEY,
	name          TEXT NOT NULL,
	root          TEXT NOT NULL,
	created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS groups (
	project_id    TEXT NOT NULL,
	name          TEXT NOT NULL,
	worktree      TEXT NOT NULL,
	branch        TEXT NOT NULL,
	base          TEXT,
	created_at    INTEGER NOT NULL,
	PRIMARY KEY (project_id, name)
);

CREATE TABLE IF NOT EXISTS agents (
	id            TEXT PRIMARY KEY,
	seat          TEXT NOT NULL,
	role          TEXT NOT NULL,
	label         TEXT NOT NULL,
	project_id    TEXT,
	project_name  TEXT,
	group_name    TEXT,
	parent_seat   TEXT,
	session_id    TEXT NOT NULL,
	session_file  TEXT,
	cwd           TEXT NOT NULL,
	pane_id       TEXT,
	model         TEXT,
	status        TEXT NOT NULL,
	registered_at INTEGER NOT NULL,
	last_seen     INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS agents_seat_alive ON agents(seat) WHERE status = 'alive';
CREATE INDEX IF NOT EXISTS agents_session ON agents(session_id);
CREATE INDEX IF NOT EXISTS agents_parent ON agents(parent_seat);

CREATE TABLE IF NOT EXISTS tasks (
	id            TEXT PRIMARY KEY,
	project_id    TEXT,
	group_name    TEXT,
	from_agent    TEXT NOT NULL,
	to_agent      TEXT,
	title         TEXT NOT NULL,
	body          TEXT NOT NULL,
	kind          TEXT NOT NULL,
	difficulty    TEXT NOT NULL,
	model         TEXT,
	status        TEXT NOT NULL,
	sha           TEXT,
	attempts      INTEGER NOT NULL DEFAULT 0,
	created_at    INTEGER NOT NULL,
	updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_to ON tasks(to_agent, status);

CREATE TABLE IF NOT EXISTS messages (
	id            TEXT PRIMARY KEY,
	from_agent    TEXT NOT NULL,
	from_seat     TEXT NOT NULL,
	to_seat       TEXT NOT NULL,
	to_agent      TEXT,
	kind          TEXT NOT NULL,
	wake          INTEGER NOT NULL,
	body          TEXT NOT NULL,
	created_at    INTEGER NOT NULL,
	delivered_at  INTEGER,
	acked_at      INTEGER
);

CREATE INDEX IF NOT EXISTS messages_inbox ON messages(to_seat, delivered_at);
CREATE INDEX IF NOT EXISTS messages_acked ON messages(to_seat, acked_at);

CREATE TABLE IF NOT EXISTS events (
	id            INTEGER PRIMARY KEY AUTOINCREMENT,
	at            INTEGER NOT NULL,
	agent_id      TEXT,
	kind          TEXT NOT NULL,
	detail        TEXT
);
`;

const MIGRATION_V2 = `
ALTER TABLE projects ADD COLUMN workspace_id TEXT;
ALTER TABLE tasks ADD COLUMN slot_id TEXT;

CREATE TABLE IF NOT EXISTS slots (
	id           TEXT PRIMARY KEY,
	project_id   TEXT,
	group_name   TEXT,
	kind         TEXT NOT NULL,
	index_no     INTEGER NOT NULL,
	worktree     TEXT NOT NULL,
	branch       TEXT NOT NULL,
	tab_id       TEXT,
	pane_id      TEXT,
	agent_id     TEXT,
	session_id   TEXT,
	status       TEXT NOT NULL,
	created_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS slots_group ON slots(project_id, group_name, kind);
`;

const MIGRATION_V3 = `
ALTER TABLE groups ADD COLUMN workspace_id TEXT;
ALTER TABLE groups ADD COLUMN tab_id TEXT;
ALTER TABLE groups ADD COLUMN lead_pane_id TEXT;
`;

const MIGRATION_V4 = `
ALTER TABLE tasks ADD COLUMN from_seat TEXT;
ALTER TABLE tasks ADD COLUMN to_seat TEXT;
ALTER TABLE tasks ADD COLUMN claimed_at INTEGER;
ALTER TABLE tasks ADD COLUMN source_slot TEXT;
ALTER TABLE tasks ADD COLUMN source_sha TEXT;
ALTER TABLE tasks ADD COLUMN parent_task TEXT;
ALTER TABLE tasks ADD COLUMN escalated_at INTEGER;
ALTER TABLE tasks ADD COLUMN pin_slot TEXT;
ALTER TABLE groups ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
ALTER TABLE groups ADD COLUMN drained_at INTEGER;
ALTER TABLE slots ADD COLUMN manual INTEGER NOT NULL DEFAULT 0;
ALTER TABLE slots ADD COLUMN tasks_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN task_id TEXT;
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id);
CREATE INDEX IF NOT EXISTS tasks_queue ON tasks(project_id, group_name, status, created_at);
CREATE INDEX IF NOT EXISTS tasks_from_seat ON tasks(from_seat, status);
`;

const MIGRATION_V5 = `
ALTER TABLE groups ADD COLUMN head_sha TEXT;
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task);
`;

const MIGRATION_V6 = `
CREATE TABLE IF NOT EXISTS state (
	key        TEXT PRIMARY KEY,
	value      TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
	session_id TEXT NOT NULL,
	day        TEXT NOT NULL,
	agent_id   TEXT,
	seat       TEXT,
	model      TEXT,
	cost       REAL NOT NULL,
	at         INTEGER NOT NULL,
	PRIMARY KEY (session_id, day)
);
CREATE INDEX IF NOT EXISTS usage_day ON usage(day);
ALTER TABLE groups ADD COLUMN paused_reason TEXT;
`;

const MIGRATION_V7 = `
ALTER TABLE usage ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
`;

const MIGRATION_V8 = `
ALTER TABLE tasks ADD COLUMN paths TEXT;
`;

export function openDb(home = teamsHome()): Database {
	mkdirSync(home, { recursive: true });
	const db = new Database(join(home, "teams.db"), { create: true });
	db.exec("PRAGMA journal_mode = WAL");
	db.exec("PRAGMA busy_timeout = 3000");
	db.exec("PRAGMA synchronous = NORMAL");
	migrate(db);
	return db;
}

function migrate(db: Database): void {
	const row = db.query("PRAGMA user_version").get() as { user_version?: number } | null;
	const current = row?.user_version ?? 0;
	if (current >= SCHEMA_VERSION) return;
	db.transaction(() => {
		if (current < 1) db.exec(SCHEMA);
		if (current < 2) db.exec(MIGRATION_V2);
		if (current < 3) db.exec(MIGRATION_V3);
		if (current < 4) db.exec(MIGRATION_V4);
		if (current < 5) db.exec(MIGRATION_V5);
		if (current < 6) db.exec(MIGRATION_V6);
		if (current < 7) db.exec(MIGRATION_V7);
		if (current < 8) db.exec(MIGRATION_V8);
		db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
	})();
}

export function logEvent(
	db: Database,
	kind: string,
	detail?: unknown,
	agentId?: string | null,
	at = Date.now(),
): void {
	try {
		db.run("INSERT INTO events (at, agent_id, kind, detail) VALUES (?, ?, ?, ?)", [
			at,
			agentId ?? null,
			kind,
			detail === undefined ? null : JSON.stringify(detail),
		]);
	} catch {
	}
}
