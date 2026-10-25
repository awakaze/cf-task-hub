PRAGMA foreign_keys = ON;

ALTER TABLE user_quotas ADD COLUMN max_auto_runs INTEGER;
ALTER TABLE job_runs ADD COLUMN depends_on_run_id TEXT;
CREATE INDEX ix_runs_dependency ON job_runs(depends_on_run_id,status);
CREATE INDEX ix_runs_job_status ON job_runs(job_id,status);

-- These claims intentionally have no run/account foreign key: removing a run,
-- job or account must never refund its rolling 24-hour execution allowance.
CREATE TABLE run_usage_claims (
 run_id TEXT PRIMARY KEY,
 owner_user_id TEXT NOT NULL,
 manual INTEGER NOT NULL CHECK(manual IN (0,1)),
 created_at INTEGER NOT NULL
);
CREATE INDEX ix_run_usage_owner_kind_time ON run_usage_claims(owner_user_id,manual,created_at);
CREATE INDEX ix_run_usage_expiry ON run_usage_claims(created_at);
INSERT OR IGNORE INTO run_usage_claims(run_id,owner_user_id,manual,created_at)
 SELECT id,owner_user_id,manual,created_at FROM job_runs
 WHERE created_at>=CAST(strftime('%s','now') AS INTEGER)*1000-172800000;

DROP TRIGGER IF EXISTS run_budget;
CREATE TRIGGER run_budget BEFORE INSERT ON job_runs
WHEN NOT EXISTS(SELECT 1 FROM job_runs WHERE job_id=NEW.job_id AND window_key=NEW.window_key) BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM job_runs r JOIN jobs j ON j.id=r.job_id
  WHERE j.account_id=(SELECT account_id FROM jobs WHERE id=NEW.job_id)
  AND r.status IN('scheduled','queued','running','waiting_retry','waiting_verification'))>=3
 THEN RAISE(ABORT,'unsettled_run_limit') END;
 SELECT CASE WHEN NEW.manual=1 AND (SELECT count(*) FROM run_usage_claims
  WHERE owner_user_id=NEW.owner_user_id AND manual=1 AND created_at>NEW.created_at-86400000)>=COALESCE(
  (SELECT max_manual_runs FROM user_quotas WHERE user_id=NEW.owner_user_id),
  (SELECT json_extract(value_json,'$.max_manual_runs') FROM system_settings WHERE key='global_quotas'),5)
 THEN RAISE(ABORT,'manual_limit') END;
 SELECT CASE WHEN NEW.manual=0 AND (SELECT count(*) FROM run_usage_claims
  WHERE owner_user_id=NEW.owner_user_id AND manual=0
  AND created_at>=CAST(strftime('%s',date(NEW.created_at/1000,'unixepoch')) AS INTEGER)*1000)>=COALESCE(
  (SELECT max_auto_runs FROM user_quotas WHERE user_id=NEW.owner_user_id),
  (SELECT json_extract(value_json,'$.max_auto_runs') FROM system_settings WHERE key='global_quotas'),10)
 THEN RAISE(ABORT,'automatic_run_limit') END;
 SELECT CASE WHEN COALESCE((SELECT count FROM usage_daily WHERE day=date(NEW.created_at/1000,'unixepoch')
  AND scope='global' AND kind='run'),0)>=COALESCE(
  (SELECT json_extract(value_json,'$.max_daily_runs') FROM system_settings WHERE key='platform_budget'),500)
 THEN RAISE(ABORT,'platform_run_limit') END;
END;
CREATE TRIGGER record_run_usage AFTER INSERT ON job_runs BEGIN
 INSERT OR IGNORE INTO run_usage_claims(run_id,owner_user_id,manual,created_at)
 VALUES(NEW.id,NEW.owner_user_id,NEW.manual,NEW.created_at);
END;

-- A dependency is allowed only for the same owner's same platform account,
-- from a coupon exchange to a coupon claim. Clients never supply raw run IDs.
CREATE TRIGGER validate_run_dependency BEFORE INSERT ON job_runs
WHEN NEW.depends_on_run_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(
  SELECT 1 FROM job_runs parent JOIN jobs pj ON pj.id=parent.job_id
  JOIN jobs child ON child.id=NEW.job_id
  WHERE parent.id=NEW.depends_on_run_id AND parent.owner_user_id=NEW.owner_user_id
  AND pj.account_id=child.account_id AND pj.task_key='bili.vip_claim' AND child.task_key='bili.exchange'
 ) THEN RAISE(ABORT,'invalid_run_dependency') END;
END;

-- Publisher/consumer completion can race. A terminal target always wins over
-- a late publisher trying to mark its intent sent again.
CREATE TRIGGER finish_run_outbox AFTER UPDATE OF status ON job_runs
WHEN NEW.status IN ('succeeded','already_done','failed','canceled','waiting_verification') BEGIN
 UPDATE outbox SET status='done',lease_token=NULL,lease_until=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE kind='run' AND ref_id=NEW.id;
 UPDATE outbox SET status='pending',next_attempt_at=CAST(strftime('%s','now') AS INTEGER)*1000,
 lease_token=NULL,lease_until=NULL
 WHERE kind='run' AND ref_id IN(SELECT id FROM job_runs WHERE depends_on_run_id=NEW.id AND status IN('scheduled','queued'));
END;
CREATE TRIGGER finish_delivery_outbox AFTER UPDATE OF status ON notification_deliveries
WHEN NEW.status IN ('delivered','failed','disabled') BEGIN
 UPDATE outbox SET status='done',lease_token=NULL,lease_until=NULL,updated_at=CAST(strftime('%s','now') AS INTEGER)*1000
 WHERE kind='notify' AND ref_id=NEW.id;
END;
CREATE TRIGGER terminal_outbox_publisher AFTER UPDATE OF status ON outbox
WHEN NEW.status='sent' AND (
 (NEW.kind='run' AND EXISTS(SELECT 1 FROM job_runs WHERE id=NEW.ref_id AND status IN('succeeded','already_done','failed','canceled','waiting_verification')))
 OR (NEW.kind='notify' AND EXISTS(SELECT 1 FROM notification_deliveries WHERE id=NEW.ref_id AND status IN('delivered','failed','disabled')))
) BEGIN
 UPDATE outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE id=NEW.id;
END;
CREATE INDEX ix_outbox_lease_cleanup ON outbox(status,lease_until);
CREATE INDEX ix_delivery_lease_cleanup ON notification_deliveries(status,lease_until);
CREATE INDEX ix_outbox_terminal_cleanup ON outbox(updated_at) WHERE status IN('done','dead','canceled');
CREATE INDEX ix_sessions_cleanup_expiry ON sessions(expires_at);
CREATE INDEX ix_sessions_cleanup_revoked ON sessions(revoked_at) WHERE revoked_at IS NOT NULL;

-- A one-time upgrade cleanup; regular maintenance starts from active targets.
UPDATE outbox SET status='done',lease_token=NULL,lease_until=NULL WHERE
 (kind='run' AND EXISTS(SELECT 1 FROM job_runs WHERE id=ref_id AND status IN('succeeded','already_done','failed','canceled','waiting_verification')))
 OR (kind='notify' AND EXISTS(SELECT 1 FROM notification_deliveries WHERE id=ref_id AND status IN('delivered','failed','disabled')));

-- Manual settlements are evidence, not a request to repeat an external action.
-- They survive resource deletion, and the application cannot rewrite them.
CREATE TABLE manual_resolutions (
 run_id TEXT PRIMARY KEY,
 owner_user_id TEXT NOT NULL,
 actor_user_id TEXT NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN('succeeded','failed')),
 evidence TEXT NOT NULL,
 checkpoint_json TEXT NOT NULL,
 resolution_id TEXT NOT NULL UNIQUE,
 created_at INTEGER NOT NULL,
 cleanup_confirmed_at INTEGER
);
CREATE INDEX ix_manual_resolutions_expiry ON manual_resolutions(created_at);
CREATE TRIGGER immutable_manual_resolution_update BEFORE UPDATE ON manual_resolutions
WHEN NOT(OLD.cleanup_confirmed_at IS NULL AND NEW.cleanup_confirmed_at IS NOT NULL
 AND NEW.cleanup_confirmed_at>=OLD.created_at AND NEW.run_id=OLD.run_id
 AND NEW.owner_user_id=OLD.owner_user_id AND NEW.actor_user_id=OLD.actor_user_id
 AND NEW.outcome=OLD.outcome AND NEW.evidence=OLD.evidence
 AND NEW.checkpoint_json=OLD.checkpoint_json AND NEW.resolution_id=OLD.resolution_id AND NEW.created_at=OLD.created_at) BEGIN
 SELECT RAISE(ABORT,'immutable_manual_resolution');
END;
CREATE TRIGGER immutable_manual_resolution_delete BEFORE DELETE ON manual_resolutions
WHEN OLD.cleanup_confirmed_at IS NULL OR OLD.created_at>=CAST(strftime('%s','now') AS INTEGER)*1000-31536000000
 OR EXISTS(SELECT 1 FROM job_runs WHERE id=OLD.run_id AND status NOT IN('succeeded','already_done','failed','canceled')) BEGIN
 SELECT RAISE(ABORT,'immutable_manual_resolution');
END;

INSERT INTO system_settings(key,value_json,updated_at) VALUES('schema_version','7',CAST(strftime('%s','now') AS INTEGER)*1000)
 ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
