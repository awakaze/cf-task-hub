PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  max_uses INTEGER NOT NULL CHECK(max_uses >= 1),
  used_count INTEGER NOT NULL DEFAULT 0 CHECK(used_count >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
  expires_at INTEGER,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK(role IN ('admin','user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
  invite_id TEXT REFERENCES invites(id),
  timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai',
  created_at INTEGER NOT NULL,
  last_login_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS only_one_admin ON users(role) WHERE role='admin';
CREATE TRIGGER IF NOT EXISTS consume_invite BEFORE INSERT ON users WHEN NEW.role='user' BEGIN
  UPDATE invites SET used_count=used_count+1 WHERE id=NEW.invite_id AND enabled=1
    AND used_count<max_uses AND (expires_at IS NULL OR expires_at>CAST(strftime('%s','now') AS INTEGER)*1000);
  SELECT CASE WHEN changes()=0 THEN RAISE(ABORT,'invalid_or_exhausted_invite') END;
  SELECT CASE WHEN (SELECT count(*) FROM users WHERE role='user' AND status<>'deleted') >= COALESCE((SELECT CAST(value_json AS INTEGER) FROM system_settings WHERE key='max_users'),100) THEN RAISE(ABORT,'user_limit_reached') END;
END;

CREATE TABLE IF NOT EXISTS passkeys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL UNIQUE, public_key TEXT NOT NULL, counter INTEGER NOT NULL DEFAULT 0,
  transports_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY, purpose TEXT NOT NULL CHECK(purpose IN ('register','login','add_passkey')),
  username TEXT, user_id TEXT, invite_id TEXT, admin_bootstrap INTEGER NOT NULL DEFAULT 0,
  challenge TEXT NOT NULL, rp_id TEXT NOT NULL, origin TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_challenges_expiry ON auth_challenges(expires_at);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, csrf_token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id,expires_at);
CREATE TABLE IF NOT EXISTS recovery_codes (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash TEXT NOT NULL, used_at INTEGER, created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,code_hash)
);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK(module_id IN ('baidu-netdisk','bilibili-vip')),
  label TEXT NOT NULL, fingerprint TEXT NOT NULL,
  credentials_enc TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(module_id,fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_accounts_owner ON accounts(owner_user_id);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL, schedule_json TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(account_id,task_key)
);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(enabled,next_run_at);
CREATE INDEX IF NOT EXISTS ix_jobs_owner ON jobs(owner_user_id);
CREATE TRIGGER IF NOT EXISTS job_account_scope BEFORE INSERT ON jobs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND owner_user_id=NEW.owner_user_id) THEN RAISE(ABORT,'job_owner_mismatch') END;
END;
CREATE TRIGGER IF NOT EXISTS job_account_scope_update BEFORE UPDATE OF owner_user_id,account_id ON jobs BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM accounts WHERE id=NEW.account_id AND owner_user_id=NEW.owner_user_id) THEN RAISE(ABORT,'job_owner_mismatch') END;
END;
CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  window_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'scheduled',
  manual INTEGER NOT NULL DEFAULT 0, scheduled_for INTEGER NOT NULL, started_at INTEGER,
  finished_at INTEGER, result_json TEXT, error_code TEXT, created_at INTEGER NOT NULL,
  UNIQUE(job_id,window_key)
);
CREATE INDEX IF NOT EXISTS ix_runs_owner_time ON job_runs(owner_user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS ix_runs_status ON job_runs(status,created_at);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, kind TEXT NOT NULL,
  ref_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(kind,ref_id)
);
CREATE INDEX IF NOT EXISTS ix_outbox_due ON outbox(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS job_events (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL, summary TEXT NOT NULL, created_at INTEGER NOT NULL, routed_at INTEGER,
  UNIQUE(run_id,event_type)
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('webhook','telegram','serverchan')),
  config_enc TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notify_channels_user ON notification_channels(owner_user_id);
CREATE TABLE IF NOT EXISTS notification_policies (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK(scope_type IN ('user','account','job')),
  scope_id TEXT NOT NULL,
  success_enabled INTEGER NOT NULL DEFAULT 1,
  exception_enabled INTEGER NOT NULL DEFAULT 1,
  success_channels_json TEXT NOT NULL DEFAULT '[]',
  error_mode TEXT NOT NULL DEFAULT 'same' CHECK(error_mode IN ('same','custom')),
  exception_channels_json TEXT NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_user_id,scope_type,scope_id)
);
CREATE TABLE IF NOT EXISTS notification_deliveries (
  id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES job_events(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES notification_channels(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, next_attempt_at INTEGER, delivered_at INTEGER,
  UNIQUE(event_id,channel_id)
);
CREATE INDEX IF NOT EXISTS ix_deliveries_status ON notification_deliveries(status,next_attempt_at);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, actor_user_id TEXT, action TEXT NOT NULL,
  target_id TEXT, meta_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_time ON audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  max_accounts INTEGER, max_jobs INTEGER, max_manual_runs INTEGER, max_notifications INTEGER, max_channels INTEGER
);
