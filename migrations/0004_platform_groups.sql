PRAGMA foreign_keys = ON;

-- Platform-first model: one group per user + platform (for example 百度网盘 or B站).
-- The group stores the shared feature switches, schedule, module settings and notification channels.
CREATE TABLE IF NOT EXISTS platform_groups (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL CHECK(module_id IN ('baidu-netdisk','bilibili-vip')),
  config_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT,
  notify_json TEXT,
  features_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(owner_user_id, module_id)
);
CREATE INDEX IF NOT EXISTS ix_platform_groups_owner ON platform_groups(owner_user_id);

-- Accounts and jobs stay as the execution unit, but now point back to their platform group.
ALTER TABLE accounts ADD COLUMN group_id TEXT;
ALTER TABLE jobs ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS ix_accounts_group ON accounts(group_id);
CREATE INDEX IF NOT EXISTS ix_jobs_group ON jobs(group_id);

-- Short-lived QR login challenges (Baidu Netdisk scan-to-login).
CREATE TABLE IF NOT EXISTS login_challenges (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module_id TEXT NOT NULL,
  sign TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  account_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_login_challenges_exp ON login_challenges(expires_at);

INSERT INTO system_settings(key,value_json,updated_at) VALUES('schema_version','5',CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
