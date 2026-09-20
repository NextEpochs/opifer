-- 0010 Authenticated mode: people sign in with a password, the interface keeps a
-- session cookie, integrations and the CLI use API keys. The role is server-wide
-- in this version (one team per server); memberships keep the per-company record
-- for a later per-company mode.

ALTER TABLE users
  ADD COLUMN password_hash text,
  ADD COLUMN role          text NOT NULL DEFAULT 'observer' CHECK (role IN ('owner', 'admin', 'operator', 'observer')),
  ADD COLUMN status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  ADD COLUMN last_login_at timestamptz;

CREATE TABLE user_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  ip            text,
  user_agent    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);
CREATE INDEX user_sessions_expires_idx ON user_sessions (expires_at);
CREATE TRIGGER user_sessions_updated_at BEFORE UPDATE ON user_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE api_keys (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid REFERENCES companies(id) ON DELETE CASCADE,
  user_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  name          text NOT NULL,
  token_hash    text NOT NULL UNIQUE,
  prefix        text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'observer')),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_keys_company_idx ON api_keys (company_id);
CREATE TRIGGER api_keys_updated_at BEFORE UPDATE ON api_keys FOR EACH ROW EXECUTE FUNCTION set_updated_at();
