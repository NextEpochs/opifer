-- 0002 Sessions: agent conversations, messages, runs and events.

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id            uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'chat'
                      CHECK (kind IN ('chat', 'task', 'routine')),
  title               text,
  -- Stable prefix: computed once per session, never modified (invariant).
  system_prompt       text NOT NULL,
  system_prompt_hash  text NOT NULL,
  model               text NOT NULL,
  fallback_model      text,
  status              text NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'suspended', 'closed')),
  workdir             text,
  last_seq            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_company_agent_idx ON sessions (company_id, agent_id, created_at DESC);

CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The system prompt does not change for the whole life of the session.
CREATE FUNCTION sessions_system_prompt_is_stable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.system_prompt_hash IS DISTINCT FROM OLD.system_prompt_hash THEN
    RAISE EXCEPTION 'the system prompt of a session is a stable prefix and cannot change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sessions_stable_prefix BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_system_prompt_is_stable();

CREATE TABLE runs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id           uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_id             uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  status               text NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'completed', 'interrupted', 'failed', 'waiting')),
  stop_reason          text,
  iterations           integer NOT NULL DEFAULT 0,
  input_tokens         integer NOT NULL DEFAULT 0,
  output_tokens        integer NOT NULL DEFAULT 0,
  cached_input_tokens  integer NOT NULL DEFAULT 0,
  -- atomic counter of the run's events (multiple concurrent writers)
  event_seq            integer NOT NULL DEFAULT 0,
  error                text,
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX runs_session_idx ON runs (session_id, started_at DESC);
CREATE INDEX runs_company_status_idx ON runs (company_id, status);

CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id  uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
  seq         integer NOT NULL,
  role        text NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
  -- List of parts: text, tool calls, tool results.
  content     jsonb NOT NULL,
  usage       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX messages_company_idx ON messages (company_id);

CREATE TRIGGER messages_updated_at BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Strict role alternation: never two consecutive messages with the same role.
CREATE FUNCTION messages_roles_alternate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_role text;
BEGIN
  SELECT role INTO previous_role FROM messages
  WHERE session_id = NEW.session_id AND seq < NEW.seq
  ORDER BY seq DESC LIMIT 1;
  IF previous_role = NEW.role THEN
    RAISE EXCEPTION 'role alternation violated: two consecutive messages with role %', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF previous_role IS NULL AND NEW.role <> 'user' THEN
    RAISE EXCEPTION 'a session always starts with a user message'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER messages_alternate BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_roles_alternate();

CREATE TABLE run_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  run_id      uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq         integer NOT NULL,
  type        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);

CREATE INDEX run_events_company_idx ON run_events (company_id);

CREATE TRIGGER run_events_updated_at BEFORE UPDATE ON run_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
