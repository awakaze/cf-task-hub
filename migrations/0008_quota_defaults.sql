-- Default per-user limits changed to 5 platform accounts and 5 notification channels.
-- Triggers live in the database, so replacing 0002 alone would not affect existing installs.
DROP TRIGGER IF EXISTS account_count_limit;
CREATE TRIGGER account_count_limit BEFORE INSERT ON accounts BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM accounts WHERE owner_user_id=NEW.owner_user_id)>=
 COALESCE((SELECT max_accounts FROM user_quotas WHERE user_id=NEW.owner_user_id),
 (SELECT json_extract(value_json,'$.max_accounts') FROM system_settings WHERE key='global_quotas'),5)
 THEN RAISE(ABORT,'account_limit') END;
END;
DROP TRIGGER IF EXISTS channel_count_limit;
CREATE TRIGGER channel_count_limit BEFORE INSERT ON notification_channels BEGIN
 SELECT CASE WHEN (SELECT count(*) FROM notification_channels WHERE owner_user_id=NEW.owner_user_id)>=
 COALESCE((SELECT max_channels FROM user_quotas WHERE user_id=NEW.owner_user_id),
 (SELECT json_extract(value_json,'$.max_channels') FROM system_settings WHERE key='global_quotas'),5)
 THEN RAISE(ABORT,'channel_limit') END;
END;
