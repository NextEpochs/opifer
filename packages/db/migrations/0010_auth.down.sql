DROP TABLE api_keys;
DROP TABLE user_sessions;
ALTER TABLE users
  DROP COLUMN last_login_at,
  DROP COLUMN status,
  DROP COLUMN role,
  DROP COLUMN password_hash;
