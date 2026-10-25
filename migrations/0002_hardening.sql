-- Upgrade v0.2 without deleting user data. Existing credentials must be reverified
-- against a stable upstream account ID before any further side effect.
ALTER TABLE accounts ADD COLUMN identity_verified_at INTEGER;
ALTER TABLE accounts ADD COLUMN verified_exchange_at INTEGER;
UPDATE accounts SET enabled=0;
UPDATE jobs SET enabled=0;
UPDATE job_runs SET status='canceled',finished_at=CAST(strftime('%s','now') AS INTEGER)*1000,error_code='UPGRADE_REVERIFY' WHERE status IN ('scheduled','queued');
ALTER TABLE outbox ADD COLUMN lease_token TEXT;
ALTER TABLE outbox ADD COLUMN lease_until INTEGER;
ALTER TABLE notification_deliveries ADD COLUMN lease_token TEXT;
ALTER TABLE notification_deliveries ADD COLUMN lease_until INTEGER;
ALTER TABLE notification_channels ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notification_channels ADD COLUMN cooldown_until INTEGER;
ALTER TABLE passkeys ADD COLUMN name TEXT NOT NULL DEFAULT 'Passkey';
ALTER TABLE passkeys ADD COLUMN last_used_at INTEGER;
ALTER TABLE job_runs ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_runs_scheduled ON job_runs(status,scheduled_for);
CREATE INDEX IF NOT EXISTS ix_events_unrouted ON job_events(routed_at,created_at);
CREATE INDEX IF NOT EXISTS ix_policies_scope ON notification_policies(scope_type,scope_id);
CREATE TABLE IF NOT EXISTS job_steps (
 id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL UNIQUE, status TEXT NOT NULL,
 report_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_steps_run ON job_steps(run_id);
CREATE TABLE IF NOT EXISTS usage_daily (
 day TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 0 CHECK(count>=0), PRIMARY KEY(day,scope,kind)
);
-- Quota checks execute in the same SQLite transaction as the write. A preceding
-- SELECT count(*) in application code alone is NOT sufficient under concurrency.
CREATE TRIGGER IF NOT EXISTS account_count_limit BEFORE INSERT ON accounts BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM accounts WHERE owner_user_id=NEW.owner_user_id)>=
 COALESCE((SELECT max_accounts FROM user_quotas WHERE user_id=NEW.owner_user_id),
 (SELECT json_extract(value_json,'$.max_accounts') FROM system_settings WHERE key='global_quotas'),3)
 THEN RAISE(ABORT,'account_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS job_count_limit BEFORE INSERT ON jobs BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM jobs WHERE owner_user_id=NEW.owner_user_id)>=
 COALESCE((SELECT max_jobs FROM user_quotas WHERE user_id=NEW.owner_user_id),
 (SELECT json_extract(value_json,'$.max_jobs') FROM system_settings WHERE key='global_quotas'),10)
 THEN RAISE(ABORT,'job_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS channel_count_limit BEFORE INSERT ON notification_channels BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM notification_channels WHERE owner_user_id=NEW.owner_user_id)>=
 COALESCE((SELECT max_channels FROM user_quotas WHERE user_id=NEW.owner_user_id),
 (SELECT json_extract(value_json,'$.max_channels') FROM system_settings WHERE key='global_quotas'),3)
 THEN RAISE(ABORT,'channel_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS run_owner_scope BEFORE INSERT ON job_runs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM jobs WHERE id=NEW.job_id AND owner_user_id=NEW.owner_user_id)
 THEN RAISE(ABORT,'run_owner_mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS run_budget BEFORE INSERT ON job_runs
WHEN NOT EXISTS(SELECT 1 FROM job_runs WHERE job_id=NEW.job_id AND window_key=NEW.window_key) BEGIN
 SELECT CASE WHEN NEW.manual=1 AND (SELECT count(*) FROM job_runs WHERE owner_user_id=NEW.owner_user_id
  AND manual=1 AND created_at>NEW.created_at-86400000)>=COALESCE(
  (SELECT max_manual_runs FROM user_quotas WHERE user_id=NEW.owner_user_id),
  (SELECT json_extract(value_json,'$.max_manual_runs') FROM system_settings WHERE key='global_quotas'),5)
 THEN RAISE(ABORT,'manual_limit') END;
 SELECT CASE WHEN COALESCE((SELECT count FROM usage_daily WHERE day=date(NEW.created_at/1000,'unixepoch')
  AND scope='global' AND kind='run'),0)>=COALESCE(
  (SELECT json_extract(value_json,'$.max_daily_runs') FROM system_settings WHERE key='platform_budget'),500)
 THEN RAISE(ABORT,'platform_run_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS run_budget_count AFTER INSERT ON job_runs BEGIN
 INSERT INTO usage_daily(day,scope,kind,count) VALUES(date(NEW.created_at/1000,'unixepoch'),'global','run',1)
 ON CONFLICT(day,scope,kind) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS delivery_owner_scope BEFORE INSERT ON notification_deliveries BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM notification_channels WHERE id=NEW.channel_id AND owner_user_id=NEW.owner_user_id)
 OR NOT EXISTS(SELECT 1 FROM job_events WHERE id=NEW.event_id AND owner_user_id=NEW.owner_user_id)
 THEN RAISE(ABORT,'delivery_owner_mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS invite_count_limit BEFORE INSERT ON invites BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM invites)>=COALESCE(
 (SELECT CAST(value_json AS INTEGER) FROM system_settings WHERE key='max_invites'),200)
 THEN RAISE(ABORT,'invite_limit') END;
END;
-- Deleting terminal resources also removes dangling policies/outbox references.
CREATE TRIGGER IF NOT EXISTS cleanup_job AFTER DELETE ON jobs BEGIN
 DELETE FROM notification_policies WHERE scope_type='job' AND scope_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_account AFTER DELETE ON accounts BEGIN
 DELETE FROM notification_policies WHERE scope_type='account' AND scope_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_run AFTER DELETE ON job_runs BEGIN
 DELETE FROM outbox WHERE kind='run' AND ref_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_delivery AFTER DELETE ON notification_deliveries BEGIN
 DELETE FROM outbox WHERE kind='notify' AND ref_id=OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS cleanup_user AFTER DELETE ON users BEGIN
 DELETE FROM outbox WHERE owner_user_id=OLD.id;
 DELETE FROM auth_challenges WHERE user_id=OLD.id;
 UPDATE audit_logs SET actor_user_id=NULL WHERE actor_user_id=OLD.id;
END;
CREATE TABLE IF NOT EXISTS usage_claims (
 id TEXT PRIMARY KEY, day TEXT NOT NULL, owner_user_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('notification')), created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_usage_claims_time ON usage_claims(created_at);
CREATE TRIGGER IF NOT EXISTS notification_budget BEFORE INSERT ON usage_claims
WHEN NOT EXISTS(SELECT 1 FROM usage_claims WHERE id=NEW.id) BEGIN
 SELECT CASE WHEN COALESCE((SELECT count FROM usage_daily WHERE day=NEW.day AND scope=NEW.owner_user_id AND kind=NEW.kind),0)>=COALESCE(
  (SELECT max_notifications FROM user_quotas WHERE user_id=NEW.owner_user_id),
  (SELECT json_extract(value_json,'$.max_notifications') FROM system_settings WHERE key='global_quotas'),20)
 THEN RAISE(ABORT,'user_notification_limit') END;
 SELECT CASE WHEN COALESCE((SELECT count FROM usage_daily WHERE day=NEW.day AND scope='global' AND kind=NEW.kind),0)>=COALESCE(
  (SELECT json_extract(value_json,'$.max_daily_notifications') FROM system_settings WHERE key='platform_budget'),500)
 THEN RAISE(ABORT,'platform_notification_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS notification_budget_count AFTER INSERT ON usage_claims BEGIN
 INSERT INTO usage_daily(day,scope,kind,count) VALUES(NEW.day,NEW.owner_user_id,NEW.kind,1)
 ON CONFLICT(day,scope,kind) DO UPDATE SET count=count+1;
 INSERT INTO usage_daily(day,scope,kind,count) VALUES(NEW.day,'global',NEW.kind,1)
 ON CONFLICT(day,scope,kind) DO UPDATE SET count=count+1;
END;
CREATE TRIGGER IF NOT EXISTS protect_account_delete BEFORE DELETE ON accounts BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs r JOIN jobs j ON r.job_id=j.id WHERE j.account_id=OLD.id
 AND r.status IN ('scheduled','queued','running','waiting_retry','waiting_verification')) THEN RAISE(ABORT,'unsettled_account') END;
END;
CREATE TRIGGER IF NOT EXISTS protect_job_delete BEFORE DELETE ON jobs BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs WHERE job_id=OLD.id AND status IN ('scheduled','queued','running','waiting_retry','waiting_verification'))
 THEN RAISE(ABORT,'unsettled_job') END;
END;
CREATE TRIGGER IF NOT EXISTS protect_credential_change BEFORE UPDATE OF credentials_enc,fingerprint ON accounts
WHEN NEW.fingerprint<>OLD.fingerprint BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM job_runs r JOIN jobs j ON r.job_id=j.id WHERE j.account_id=OLD.id AND r.status IN ('scheduled','queued','running','waiting_retry','waiting_verification'))
 THEN RAISE(ABORT,'unsettled_account') END;
END;
CREATE TRIGGER IF NOT EXISTS passkey_count_limit BEFORE INSERT ON passkeys BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM passkeys WHERE user_id=NEW.user_id)>=10 THEN RAISE(ABORT,'passkey_limit') END;
END;
CREATE TRIGGER IF NOT EXISTS active_run_owner BEFORE INSERT ON job_runs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.owner_user_id AND status='active') THEN RAISE(ABORT,'inactive_user') END;
END;

INSERT INTO system_settings(key,value_json,updated_at) VALUES('schema_version','3',CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;

CREATE TRIGGER IF NOT EXISTS protect_last_passkey BEFORE DELETE ON passkeys WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id) BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM passkeys WHERE user_id=OLD.user_id)<=1 THEN RAISE(ABORT,'last_passkey') END;
END;
