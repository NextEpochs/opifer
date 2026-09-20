-- 0002 Sessioni: conversazioni degli agenti, messaggi, esecuzioni ed eventi.

CREATE TABLE sessions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id            uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind                text NOT NULL DEFAULT 'chat'
                      CHECK (kind IN ('chat', 'task', 'routine')),
  title               text,
  -- Prefisso stabile: calcolato una volta per sessione, mai modificato (invariante).
  system_prompt       text NOT NULL,
  system_prompt_hash  text NOT NULL,
  model               text NOT NULL,
  fallback_model      text,
  status              text NOT NULL DEFAULT 'attiva'
                      CHECK (status IN ('attiva', 'sospesa', 'chiusa')),
  workdir             text,
  last_seq            integer NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_company_agent_idx ON sessions (company_id, agent_id, created_at DESC);

CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Il prompt di sistema non cambia per tutta la durata della sessione.
CREATE FUNCTION sessions_system_prompt_is_stable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.system_prompt IS DISTINCT FROM OLD.system_prompt
     OR NEW.system_prompt_hash IS DISTINCT FROM OLD.system_prompt_hash THEN
    RAISE EXCEPTION 'il prompt di sistema di una sessione è un prefisso stabile e non si modifica'
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
  status               text NOT NULL DEFAULT 'in_corso'
                       CHECK (status IN ('in_corso', 'conclusa', 'interrotta', 'fallita', 'in_attesa')),
  stop_reason          text,
  iterations           integer NOT NULL DEFAULT 0,
  input_tokens         integer NOT NULL DEFAULT 0,
  output_tokens        integer NOT NULL DEFAULT 0,
  cached_input_tokens  integer NOT NULL DEFAULT 0,
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
  -- Elenco di parti: testo, chiamate a tool, risultati di tool.
  content     jsonb NOT NULL,
  usage       jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, seq)
);

CREATE INDEX messages_company_idx ON messages (company_id);

CREATE TRIGGER messages_updated_at BEFORE UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Alternanza rigorosa dei ruoli: mai due messaggi consecutivi dello stesso ruolo.
CREATE FUNCTION messages_roles_alternate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  previous_role text;
BEGIN
  SELECT role INTO previous_role FROM messages
  WHERE session_id = NEW.session_id AND seq < NEW.seq
  ORDER BY seq DESC LIMIT 1;
  IF previous_role = NEW.role THEN
    RAISE EXCEPTION 'alternanza dei ruoli violata: due messaggi consecutivi con ruolo %', NEW.role
      USING ERRCODE = 'check_violation';
  END IF;
  IF previous_role IS NULL AND NEW.role <> 'user' THEN
    RAISE EXCEPTION 'una sessione inizia sempre con un messaggio utente'
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
