PRAGMA foreign_keys = ON;

-- Only a session created by a consumed recovery code receives this short,
-- single-use password reset grant. Existing sessions have no grant.
ALTER TABLE sessions ADD COLUMN recovery_reset_expires_at INTEGER;
ALTER TABLE sessions ADD COLUMN recovery_reset_used_at INTEGER;

INSERT INTO system_settings(key,value_json,updated_at)
VALUES('schema_version','6',CAST(strftime('%s','now') AS INTEGER)*1000)
ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
