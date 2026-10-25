-- Additive upgrade: no credentials, task history or uncertain-operation evidence
-- is deleted. Apply all migrations before deploying v0.4.0.
ALTER TABLE login_challenges ADD COLUMN lease_token TEXT;
ALTER TABLE login_challenges ADD COLUMN lease_until INTEGER;
ALTER TABLE login_challenges ADD COLUMN poll_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_challenges ADD COLUMN next_poll_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_challenges ADD COLUMN target_account_id TEXT;
ALTER TABLE login_challenges ADD COLUMN resume_jobs INTEGER NOT NULL DEFAULT 0;
ALTER TABLE login_challenges ADD COLUMN last_error TEXT;
UPDATE login_challenges SET status=CASE
 WHEN account_id IS NOT NULL AND EXISTS(SELECT 1 FROM accounts a WHERE a.id=login_challenges.account_id AND a.owner_user_id=login_challenges.owner_user_id) THEN 'confirmed'
 ELSE 'failed' END,last_error=CASE WHEN account_id IS NULL THEN 'UPGRADE_RESCAN' ELSE NULL END
 WHERE consumed_at IS NOT NULL;
CREATE INDEX ix_login_challenges_owner_expiry ON login_challenges(owner_user_id,expires_at);

CREATE TABLE platform_run_requests (
 request_key TEXT PRIMARY KEY,
 owner_user_id TEXT NOT NULL,
 module_id TEXT NOT NULL,
 request_hash TEXT NOT NULL,
 result_json TEXT NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE INDEX ix_platform_run_requests_expiry ON platform_run_requests(created_at);

-- An ephemeral SQL assertion, inserted and removed inside the same D1 batch.
-- CHECK failure rolls back the entire mutation after a concurrent delete,
-- suspension or expired lease, rather than treating an UPDATE of zero rows as
-- a successful binding. Committed transactions leave this table empty.
CREATE TABLE mutation_guards (
 id TEXT PRIMARY KEY,
 ok INTEGER NOT NULL CONSTRAINT mutation_guard_valid CHECK(ok=1)
);

-- Existing explicit empty notification policies are preserved. New groups use
-- NULL for inheritance; users can select inheritance in the upgraded UI.
INSERT INTO system_settings(key,value_json,updated_at)
 VALUES('schema_version','8',CAST(strftime('%s','now') AS INTEGER)*1000)
 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
