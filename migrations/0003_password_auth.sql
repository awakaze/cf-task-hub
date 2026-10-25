PRAGMA foreign_keys = ON;

-- Login with username + password is the default; Passkeys stay optional.
ALTER TABLE users ADD COLUMN password_hash TEXT;
-- Custom invitation codes are stored encrypted so the administrator can read them back.
ALTER TABLE invites ADD COLUMN code_enc TEXT;

-- Passkeys are optional now, so the last key may be removed when a password exists.
DROP TRIGGER IF EXISTS protect_last_passkey;
CREATE TRIGGER protect_last_passkey BEFORE DELETE ON passkeys WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.user_id AND password_hash IS NULL) BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM passkeys WHERE user_id=OLD.user_id)<=1 THEN RAISE(ABORT,'last_passkey') END;
END;

INSERT INTO system_settings(key,value_json,updated_at) VALUES('schema_version','4',CAST(strftime('%s','now') AS INTEGER)*1000) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at;
