PRAGMA foreign_keys = ON;

-- No credentials here: tokens and crash-recovery state stay in credentials_enc.
CREATE TABLE bili_sessions (
 account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
 status TEXT NOT NULL DEFAULT 'ready' CHECK(status IN('ready','retry','needs_login')),
 next_check_at INTEGER NOT NULL,
 last_checked_at INTEGER,
 last_refreshed_at INTEGER,
 lease_token TEXT,
 lease_until INTEGER
);
CREATE INDEX ix_bili_sessions_due ON bili_sessions(status,next_check_at);

INSERT INTO system_settings(key,value_json,updated_at) VALUES('schema_version','9',CAST(strftime('%s','now') AS INTEGER)*1000)
ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
