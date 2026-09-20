-- 0003 Governance: budgets, cost events, reservations, approvals, tool policies, secrets.

-- Spending caps per scope and window. The most restrictive applicable cap wins.
CREATE TABLE budget_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope_kind   text NOT NULL CHECK (scope_kind IN ('company', 'project', 'agent', 'task', 'turn')),
  -- NULL for the company scope; the project/agent/task id otherwise.
  scope_id     uuid,
  "window"     text NOT NULL DEFAULT 'monthly' CHECK ("window" IN ('monthly', 'daily', 'lifetime')),
  cap          numeric(14, 6) NOT NULL CHECK (cap >= 0),
  currency     text NOT NULL DEFAULT 'EUR' CHECK (currency IN ('EUR', 'USD')),
  warn_ratio   numeric(4, 3) NOT NULL DEFAULT 0.8 CHECK (warn_ratio > 0 AND warn_ratio <= 1),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, scope_kind, scope_id, "window")
);

CREATE INDEX budget_policies_company_idx ON budget_policies (company_id);
CREATE TRIGGER budget_policies_updated_at BEFORE UPDATE ON budget_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every paid call, settled: model, tokens, amount. Totals at every level come from here.
CREATE TABLE cost_events (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id             uuid REFERENCES agents(id) ON DELETE SET NULL,
  session_id           uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id               uuid REFERENCES runs(id) ON DELETE SET NULL,
  project_id           uuid,
  task_id              uuid,
  kind                 text NOT NULL CHECK (kind IN ('model', 'auxiliary_model', 'tool', 'sandbox')),
  provider             text,
  model                text,
  input_tokens         integer NOT NULL DEFAULT 0,
  cached_input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens        integer NOT NULL DEFAULT 0,
  amount_usd           numeric(14, 6) NOT NULL DEFAULT 0,
  amount_eur           numeric(14, 6) NOT NULL DEFAULT 0,
  occurred_at          timestamptz NOT NULL DEFAULT now(),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX cost_events_company_time_idx ON cost_events (company_id, occurred_at DESC);
CREATE INDEX cost_events_agent_time_idx ON cost_events (agent_id, occurred_at DESC);
CREATE INDEX cost_events_run_idx ON cost_events (run_id);
CREATE TRIGGER cost_events_updated_at BEFORE UPDATE ON cost_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Open reservations count as spending until settled or released: the overrun is at most one call.
CREATE TABLE budget_reservations (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id       uuid REFERENCES agents(id) ON DELETE SET NULL,
  session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id         uuid REFERENCES runs(id) ON DELETE SET NULL,
  project_id     uuid,
  task_id        uuid,
  estimated_usd  numeric(14, 6) NOT NULL DEFAULT 0,
  estimated_eur  numeric(14, 6) NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'settled', 'released')),
  cost_event_id  uuid REFERENCES cost_events(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  settled_at     timestamptz
);

CREATE INDEX budget_reservations_open_idx ON budget_reservations (company_id, status);
CREATE TRIGGER budget_reservations_updated_at BEFORE UPDATE ON budget_reservations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Decisions a person has to take: tool use, dangerous commands, budget increases, ...
CREATE TABLE approvals (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind             text NOT NULL CHECK (kind IN ('tool_use', 'dangerous_command', 'budget_increase', 'agent_hire', 'plan', 'skill_promotion', 'config_change', 'secret_access')),
  agent_id         uuid REFERENCES agents(id) ON DELETE SET NULL,
  session_id       uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id           uuid REFERENCES runs(id) ON DELETE SET NULL,
  task_id          uuid,
  -- What is being asked: tool name and arguments, the command, the requested cap, ...
  subject          jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason           text,
  estimated_cost   numeric(14, 6),
  risk             text NOT NULL DEFAULT 'medium' CHECK (risk IN ('low', 'medium', 'high')),
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by       uuid REFERENCES users(id) ON DELETE SET NULL,
  decision_note    text,
  expires_at       timestamptz,
  decided_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX approvals_company_status_idx ON approvals (company_id, status, created_at DESC);
CREATE INDEX approvals_session_idx ON approvals (session_id);
CREATE TRIGGER approvals_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Permission per role or agent on every tool: automatic, approval, blocked.
CREATE TABLE tool_policies (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  target_kind  text NOT NULL CHECK (target_kind IN ('company', 'role', 'agent')),
  -- NULL for the company default, the role name for roles, the agent id (as text) for agents.
  target_id    text,
  tool_name    text NOT NULL,
  permission   text NOT NULL CHECK (permission IN ('automatic', 'approval', 'blocked')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, target_kind, target_id, tool_name)
);

CREATE INDEX tool_policies_company_idx ON tool_policies (company_id);
CREATE TRIGGER tool_policies_updated_at BEFORE UPDATE ON tool_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Encrypted per company, versioned; the plaintext never leaves the gateway.
CREATE TABLE secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL,
  version      integer NOT NULL DEFAULT 1,
  ciphertext   bytea NOT NULL,
  nonce        bytea NOT NULL,
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name, version)
);

CREATE INDEX secrets_company_name_idx ON secrets (company_id, name);
CREATE TRIGGER secrets_updated_at BEFORE UPDATE ON secrets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A secret is usable only by the agents and tools it is explicitly bound to.
CREATE TABLE secret_bindings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  secret_name  text NOT NULL,
  agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
  -- NULL means every tool; otherwise one tool name.
  tool_name    text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, secret_name, agent_id, tool_name)
);

CREATE INDEX secret_bindings_company_idx ON secret_bindings (company_id);
CREATE TRIGGER secret_bindings_updated_at BEFORE UPDATE ON secret_bindings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every resolution of a secret value is recorded.
CREATE TABLE secret_access_events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  secret_name  text NOT NULL,
  agent_id     uuid REFERENCES agents(id) ON DELETE SET NULL,
  session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  tool_name    text,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX secret_access_events_company_idx ON secret_access_events (company_id, occurred_at DESC);
CREATE TRIGGER secret_access_events_updated_at BEFORE UPDATE ON secret_access_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
