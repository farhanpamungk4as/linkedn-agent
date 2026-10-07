import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 6;

export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function migrateDatabase(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version > SCHEMA_VERSION) {
    throw new Error(`Database schema ${version.user_version} is newer than this app supports`);
  }
  if (version.user_version === SCHEMA_VERSION) return;
  if (version.user_version === 0) db.exec(`
    BEGIN;
    CREATE TABLE leads (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      linkedin_url TEXT NOT NULL UNIQUE,
      company TEXT,
      status TEXT NOT NULL DEFAULT 'NEW'
        CHECK (status IN ('NEW', 'QUALIFIED', 'APPROVED', 'SENT', 'REPLIED', 'HUMAN_TAKEOVER', 'SKIPPED', 'FAILED')),
      template_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      sent_at TEXT,
      replied_at TEXT
    ) STRICT;
    CREATE INDEX leads_status_idx ON leads(status);
    PRAGMA user_version = 1;
    COMMIT;
  `);
  if (version.user_version < 2) db.exec(`
    BEGIN;
    ALTER TABLE leads ADD COLUMN job_title TEXT;
    ALTER TABLE leads ADD COLUMN location TEXT;
    ALTER TABLE leads ADD COLUMN score INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100));
    ALTER TABLE leads ADD COLUMN score_reason TEXT;
    ALTER TABLE leads ADD COLUMN approved_at TEXT;
    ALTER TABLE leads ADD COLUMN last_checked_at TEXT;
    ALTER TABLE leads ADD COLUMN error_message TEXT;
    ALTER TABLE leads ADD COLUMN outreach_claimed_at TEXT;
    ALTER TABLE leads ADD COLUMN outreach_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE leads ADD COLUMN monitor_failures INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;
    CREATE TABLE activity_logs (
      id TEXT PRIMARY KEY,
      lead_id TEXT REFERENCES leads(id) ON DELETE SET NULL,
      event TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;
    CREATE INDEX activity_lead_idx ON activity_logs(lead_id, created_at DESC);
    CREATE TABLE system_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
      outreach_enabled INTEGER NOT NULL DEFAULT 1 CHECK (outreach_enabled IN (0, 1)),
      monitor_enabled INTEGER NOT NULL DEFAULT 1 CHECK (monitor_enabled IN (0, 1)),
      telegram_offset INTEGER NOT NULL DEFAULT 0
    ) STRICT;
    INSERT INTO system_settings (id) VALUES (1);
    CREATE TABLE job_runs (
      name TEXT PRIMARY KEY,
      last_started_at TEXT,
      last_finished_at TEXT,
      last_status TEXT,
      last_error TEXT
    ) STRICT;
    INSERT INTO job_runs (name) VALUES ('outreach'), ('replies');
    PRAGMA user_version = 2;
    COMMIT;
  `);
  if (version.user_version < 3) db.exec(`
    BEGIN;
    ALTER TABLE leads ADD COLUMN error_class TEXT;
    CREATE INDEX IF NOT EXISTS leads_sent_at_idx ON leads(sent_at);
    CREATE INDEX IF NOT EXISTS leads_replied_at_idx ON leads(replied_at);
    CREATE INDEX IF NOT EXISTS activity_created_idx ON activity_logs(created_at DESC);
    CREATE TABLE pending_actions (
      lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('manual', 'approval')),
      state TEXT NOT NULL CHECK (state IN ('PREPARED', 'SENDING', 'SENT', 'CANCELLED', 'UNCERTAIN', 'BLOCKED')),
      message TEXT NOT NULL,
      profile_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      send_started_at TEXT,
      sent_at TEXT,
      send_day TEXT,
      send_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    ) STRICT;
    CREATE INDEX pending_state_idx ON pending_actions(state);
    PRAGMA user_version = 3;
    COMMIT;
  `);
  if (version.user_version < 4) db.exec(`
    BEGIN;
    ALTER TABLE pending_actions ADD COLUMN kind TEXT NOT NULL DEFAULT 'initial'
      CHECK (kind IN ('initial', 'follow_up'));
    PRAGMA user_version = 4;
    COMMIT;
  `);
  if (version.user_version < 5) db.exec(`
    BEGIN;
    CREATE TABLE conversation_messages (
      id TEXT PRIMARY KEY,
      lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
      direction TEXT NOT NULL CHECK (direction IN ('outgoing', 'incoming')),
      body TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('playwright', 'manual', 'linkedin')),
      UNIQUE (lead_id, direction, body, sent_at)
    ) STRICT;
    CREATE INDEX conversation_messages_lead_time_idx ON conversation_messages(lead_id, sent_at, observed_at);
    INSERT OR IGNORE INTO conversation_messages (id, lead_id, direction, body, sent_at, observed_at, source)
      SELECT lower(hex(randomblob(16))), pending_actions.lead_id, 'outgoing', pending_actions.message,
        COALESCE(pending_actions.sent_at, leads.sent_at, pending_actions.updated_at), pending_actions.updated_at,
        CASE WHEN pending_actions.mode = 'manual' OR EXISTS (
          SELECT 1 FROM activity_logs WHERE activity_logs.lead_id = pending_actions.lead_id
            AND activity_logs.event = 'manually_confirmed_sent'
        ) THEN 'manual' ELSE 'playwright' END
      FROM pending_actions JOIN leads ON leads.id = pending_actions.lead_id
      WHERE pending_actions.state = 'SENT' AND trim(pending_actions.message) <> '';
    PRAGMA user_version = 5;
    COMMIT;
  `);
  if (version.user_version < 6) db.exec(`
    BEGIN;
    ALTER TABLE leads ADD COLUMN human_handled_at TEXT;
    ALTER TABLE leads ADD COLUMN conversation_url TEXT;
    CREATE INDEX leads_human_handled_idx ON leads(status, human_handled_at, replied_at);
    PRAGMA user_version = 6;
    COMMIT;
  `);
}

export function requireInitialized(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version.user_version !== SCHEMA_VERSION) {
    throw new Error("Database is not initialized. Run: npm run db:init");
  }
}
