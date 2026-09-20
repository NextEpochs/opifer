-- 0001 Foundations: organization and audit.
-- Every domain table carries company_id, created_at, updated_at.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE companies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  mission     text,
  status      text NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended', 'archived')),
  settings    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name  text NOT NULL,
  email         text UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        text NOT NULL
              CHECK (role IN ('owner', 'admin', 'operator', 'observer')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, user_id)
);

CREATE TABLE agents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  role                 text NOT NULL DEFAULT '',
  reports_to_agent_id  uuid REFERENCES agents(id) ON DELETE SET NULL,
  reports_to_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
  model                text,
  status               text NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'paused', 'budget_stopped', 'archived')),
  current_revision     integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  -- tree-shaped org chart: at most one manager
  CHECK (reports_to_agent_id IS NULL OR reports_to_user_id IS NULL),
  UNIQUE (company_id, name)
);

CREATE INDEX agents_company_idx ON agents (company_id);

CREATE TABLE agent_revisions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id    uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision    integer NOT NULL,
  config      jsonb NOT NULL,
  author_kind text NOT NULL CHECK (author_kind IN ('person', 'agent', 'system')),
  author_id   uuid,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, revision)
);

CREATE INDEX agent_revisions_company_idx ON agent_revisions (company_id);

-- Immutable log: inserts only. Updates and deletes are blocked by a
-- trigger; in production also by separate permissions.
CREATE TABLE audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE RESTRICT,
  actor_kind    text NOT NULL CHECK (actor_kind IN ('person', 'agent', 'system')),
  actor_id      uuid,
  action        text NOT NULL,
  subject_kind  text NOT NULL,
  subject_id    uuid,
  task_id       uuid,
  before        jsonb,
  after         jsonb,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_company_time_idx ON audit_log (company_id, occurred_at DESC);

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is an append-only, immutable log: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update_no_delete
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- automatic updated_at on every table that carries it.
CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER companies_updated_at BEFORE UPDATE ON companies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER memberships_updated_at BEFORE UPDATE ON memberships
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER agent_revisions_updated_at BEFORE UPDATE ON agent_revisions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
