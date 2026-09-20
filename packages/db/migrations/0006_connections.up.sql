-- 0006 Connections: routines with at-most-once runs, tool connections (MCP
-- servers and workflow tools), inbound webhooks, outbound signed events,
-- messaging channels and their bindings.

-- Recurring work: an agent, a prompt, a schedule. Each run has its own session.
CREATE TABLE routines (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id           uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name               text NOT NULL,
  prompt             text NOT NULL,
  -- interval: every N seconds; cron: five-field expression; once: a single date.
  schedule_kind      text NOT NULL CHECK (schedule_kind IN ('interval', 'cron', 'once')),
  schedule           text NOT NULL,
  timezone           text NOT NULL DEFAULT 'UTC',
  -- Skills loaded into the run's context, by name.
  skills             text[] NOT NULL DEFAULT '{}',
  model              text,
  -- Where the result goes: channel ids and/or 'inbox'.
  deliver_to         jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Missed due times older than this are skipped, not caught up.
  catch_up_seconds   integer NOT NULL DEFAULT 3600 CHECK (catch_up_seconds >= 0),
  -- A run is stopped after this long without activity, never for its duration.
  idle_timeout_seconds integer NOT NULL DEFAULT 600 CHECK (idle_timeout_seconds > 0),
  -- Routines do not write memory unless told to.
  learn              boolean NOT NULL DEFAULT false,
  enabled            boolean NOT NULL DEFAULT true,
  next_due_at        timestamptz,
  last_run_at        timestamptz,
  created_by_kind    text NOT NULL DEFAULT 'person' CHECK (created_by_kind IN ('person', 'agent', 'system')),
  created_by_id      uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE INDEX routines_due_idx ON routines (enabled, next_due_at);
CREATE TRIGGER routines_updated_at BEFORE UPDATE ON routines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One row per due time: the unique key is the at-most-once guarantee. A
-- second scheduler (or the same one after a crash) cannot claim it again.
CREATE TABLE routine_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  routine_id    uuid NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  due_at        timestamptz NOT NULL,
  session_id    uuid REFERENCES sessions(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'running', 'done', 'failed', 'skipped', 'interrupted')),
  -- The last assistant text of the run, delivered to the channels.
  result        text,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, due_at)
);

CREATE INDEX routine_runs_routine_idx ON routine_runs (routine_id, due_at DESC);
CREATE TRIGGER routine_runs_updated_at BEFORE UPDATE ON routine_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Tool connections: MCP servers (stdio or HTTP) and workflow tools (an HTTP
-- endpoint such as an n8n workflow, described as a tool). Every tool they
-- expose goes through the same gate as a native tool.
CREATE TABLE tool_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('mcp_stdio', 'mcp_http', 'workflow')),
  -- Short name, prefix of the tool names: `<name>__<tool>`.
  name             text NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- mcp_stdio: { command, args, env }; mcp_http: { url, headers }; workflow: { url, method, headers, inputSchema, description }.
  config           jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Default risk of the tools exposed by this connection.
  risk             text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  -- Names of company secrets injected as environment variables or headers.
  secret_names     text[] NOT NULL DEFAULT '{}',
  enabled          boolean NOT NULL DEFAULT true,
  status           text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'degraded', 'failed', 'missing_secret')),
  status_detail    text,
  -- The tools discovered at the last check: [{ name, description, inputSchema }].
  tools            jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
);

CREATE INDEX tool_connections_company_idx ON tool_connections (company_id, enabled);
CREATE TRIGGER tool_connections_updated_at BEFORE UPDATE ON tool_connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Inbound webhooks: an external system creates a task, wakes an agent, comments or decides.
CREATE TABLE webhooks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  action        text NOT NULL CHECK (action IN ('create_task', 'wake_agent', 'comment', 'decide_approval')),
  -- Hash of the bearer token (the token itself is shown once, at creation).
  token_hash    text NOT NULL,
  -- Defaults for the action: agentId, projectId, priority, sessionTitle...
  defaults      jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  calls         integer NOT NULL DEFAULT 0,
  last_called_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TRIGGER webhooks_updated_at BEFORE UPDATE ON webhooks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Outbound events: signed deliveries of the company's events to a URL.
CREATE TABLE event_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name          text NOT NULL,
  url           text NOT NULL,
  -- Event types, or ['*'].
  events        text[] NOT NULL DEFAULT '{*}',
  -- HMAC-SHA256 key for the X-Opifer-Signature header.
  secret        text NOT NULL,
  enabled       boolean NOT NULL DEFAULT true,
  failures      integer NOT NULL DEFAULT 0,
  last_delivered_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TRIGGER event_subscriptions_updated_at BEFORE UPDATE ON event_subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE event_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  subscription_id  uuid NOT NULL REFERENCES event_subscriptions(id) ON DELETE CASCADE,
  event_type       text NOT NULL,
  payload          jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  response_status  integer,
  error            text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX event_deliveries_pending_idx ON event_deliveries (status, next_attempt_at);
CREATE TRIGGER event_deliveries_updated_at BEFORE UPDATE ON event_deliveries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Messaging channels: one bot per company per kind. The token is a company secret.
CREATE TABLE channels (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('telegram')),
  name          text NOT NULL,
  -- Name of the company secret holding the bot token.
  secret_name   text NOT NULL,
  -- The agent that answers chats with no explicit binding.
  default_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  -- Kind-specific: { botUsername } for Telegram.
  config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled       boolean NOT NULL DEFAULT true,
  status        text NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'healthy', 'failed', 'missing_secret')),
  status_detail text,
  last_seen_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Who is who on a channel: an external sender is a known person (paired with
-- a code); a chat is bound to an agent and keeps its session.
CREATE TABLE channel_bindings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  channel_id         uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  external_sender_id text NOT NULL,
  external_chat_id   text NOT NULL,
  -- The person behind the sender; NULL until paired.
  user_id            uuid REFERENCES users(id) ON DELETE SET NULL,
  display_name       text NOT NULL DEFAULT '',
  -- Pairing: the code a person types in the interface to claim this sender.
  pairing_code       text,
  pairing_expires_at timestamptz,
  agent_id           uuid REFERENCES agents(id) ON DELETE SET NULL,
  session_id         uuid REFERENCES sessions(id) ON DELETE SET NULL,
  -- Receives approval requests and finished-work notifications.
  notify             boolean NOT NULL DEFAULT true,
  last_message_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (channel_id, external_chat_id, external_sender_id)
);

CREATE INDEX channel_bindings_pairing_idx ON channel_bindings (pairing_code) WHERE pairing_code IS NOT NULL;
CREATE TRIGGER channel_bindings_updated_at BEFORE UPDATE ON channel_bindings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
