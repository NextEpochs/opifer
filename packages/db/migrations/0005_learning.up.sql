-- 0005 Learning: memories, skills with versions and usage, background reviews,
-- promotions between scopes, per-company learning settings, curator backups.

-- Per-company learning policy. One row per company, created on demand.
CREATE TABLE learning_settings (
  company_id             uuid PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  -- Whether the background review runs after a turn.
  review_enabled         boolean NOT NULL DEFAULT true,
  -- How knowledge rises a level: by itself, after a person's review, or never.
  promotion              text NOT NULL DEFAULT 'review' CHECK (promotion IN ('automatic', 'review', 'forbidden')),
  -- Successful uses of an agent skill before a promotion is proposed.
  promotion_threshold    integer NOT NULL DEFAULT 3 CHECK (promotion_threshold > 0),
  -- Size cap of the memory snapshot that enters the prompt, in characters.
  snapshot_max_chars     integer NOT NULL DEFAULT 6000 CHECK (snapshot_max_chars > 0),
  -- Curator thresholds, in days, for skills created by agents.
  inactive_after_days    integer NOT NULL DEFAULT 30 CHECK (inactive_after_days > 0),
  archive_after_days     integer NOT NULL DEFAULT 90 CHECK (archive_after_days > 0),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER learning_settings_updated_at BEFORE UPDATE ON learning_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- What an agent has learned: notes on how to work, and profiles of the people
-- and systems it works with. Scoped to an agent, a team (the sub-tree under
-- an agent) or the whole company. Never deleted: retired or superseded.
CREATE TABLE memories (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope              text NOT NULL CHECK (scope IN ('agent', 'team', 'company')),
  -- The agent (scope agent) or the root of the sub-tree (scope team); NULL for the company.
  scope_agent_id     uuid REFERENCES agents(id) ON DELETE CASCADE,
  kind               text NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'profile')),
  -- For profiles: who or what the entry is about.
  subject            text NOT NULL DEFAULT '',
  content            text NOT NULL,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired', 'superseded')),
  -- A correction creates a new entry that supersedes this one.
  supersedes_id      uuid REFERENCES memories(id) ON DELETE SET NULL,
  pinned             boolean NOT NULL DEFAULT false,
  -- Where it comes from.
  source_session_id  uuid REFERENCES sessions(id) ON DELETE SET NULL,
  source_run_id      uuid REFERENCES runs(id) ON DELETE SET NULL,
  source_task_id     uuid REFERENCES tasks(id) ON DELETE SET NULL,
  author_kind        text NOT NULL DEFAULT 'agent' CHECK (author_kind IN ('person', 'agent', 'system')),
  author_id          uuid,
  -- Semantic vector, when an embedder is configured; NULL otherwise.
  embedding          real[],
  search             tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(subject, '') || ' ' || content)) STORED,
  retired_reason     text,
  retired_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'company') = (scope_agent_id IS NULL))
);

CREATE INDEX memories_scope_idx ON memories (company_id, scope, scope_agent_id, status);
CREATE INDEX memories_search_idx ON memories USING gin (search);
CREATE INDEX memories_session_idx ON memories (source_session_id);
CREATE TRIGGER memories_updated_at BEFORE UPDATE ON memories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A reusable procedure: a SKILL.md with a header and optional files. Only the
-- index (name and description) enters the prompt; the body is loaded on demand.
CREATE TABLE skills (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  scope                 text NOT NULL CHECK (scope IN ('agent', 'team', 'company')),
  scope_agent_id        uuid REFERENCES agents(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  description           text NOT NULL DEFAULT '',
  tags                  text[] NOT NULL DEFAULT '{}',
  -- Who made it: an agent (subject to the curator), a person, or an import.
  origin                text NOT NULL CHECK (origin IN ('agent', 'person', 'imported')),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'archived')),
  -- Pinned by a person: excluded from every automatism.
  pinned                boolean NOT NULL DEFAULT false,
  current_version       integer NOT NULL DEFAULT 1,
  uses                  integer NOT NULL DEFAULT 0,
  last_used_at          timestamptz,
  -- The agent-scope skill this one was promoted from, if any.
  promoted_from_id      uuid REFERENCES skills(id) ON DELETE SET NULL,
  created_by_kind       text NOT NULL DEFAULT 'agent' CHECK (created_by_kind IN ('person', 'agent', 'system')),
  created_by_id         uuid,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'company') = (scope_agent_id IS NULL)),
  CHECK (name ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

-- One name per scope: an agent's skill and a company skill may share a name (the closer one wins).
CREATE UNIQUE INDEX skills_name_idx ON skills (company_id, scope, coalesce(scope_agent_id, '00000000-0000-0000-0000-000000000000'::uuid), name);
CREATE INDEX skills_scope_idx ON skills (company_id, scope, scope_agent_id, status);
CREATE TRIGGER skills_updated_at BEFORE UPDATE ON skills FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every change to a skill is a version; restoring an old one is a new version.
CREATE TABLE skill_versions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_id         uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version          integer NOT NULL,
  description      text NOT NULL DEFAULT '',
  -- The body of SKILL.md, without the header.
  content          text NOT NULL,
  -- Optional files: { "scripts/check.sh": "...", "references/notes.md": "..." }.
  files            jsonb NOT NULL DEFAULT '{}'::jsonb,
  note             text NOT NULL DEFAULT '',
  created_by_kind  text NOT NULL DEFAULT 'agent' CHECK (created_by_kind IN ('person', 'agent', 'system')),
  created_by_id    uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version)
);

CREATE TRIGGER skill_versions_updated_at BEFORE UPDATE ON skill_versions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Every time an agent loads a skill: who, where, and how the work ended.
CREATE TABLE skill_usage (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  skill_id     uuid NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  version      integer NOT NULL,
  agent_id     uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id   uuid REFERENCES sessions(id) ON DELETE SET NULL,
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  task_id      uuid REFERENCES tasks(id) ON DELETE SET NULL,
  -- Filled in when the task closes: done → success, blocked/cancelled → failure.
  outcome      text NOT NULL DEFAULT 'unknown' CHECK (outcome IN ('unknown', 'success', 'failure')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX skill_usage_skill_idx ON skill_usage (skill_id, outcome);
CREATE INDEX skill_usage_task_idx ON skill_usage (task_id);
CREATE TRIGGER skill_usage_updated_at BEFORE UPDATE ON skill_usage FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The background review of a finished turn: what it proposed and what was saved.
CREATE TABLE learning_reviews (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
  task_id       uuid REFERENCES tasks(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  -- The model's proposals, as returned.
  proposals     jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What was written: memory ids and skill ids with versions.
  applied       jsonb NOT NULL DEFAULT '{}'::jsonb,
  cost_eur      numeric(12, 6) NOT NULL DEFAULT 0,
  error         text,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX learning_reviews_company_idx ON learning_reviews (company_id, status, created_at DESC);
CREATE INDEX learning_reviews_session_idx ON learning_reviews (session_id);
CREATE TRIGGER learning_reviews_updated_at BEFORE UPDATE ON learning_reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A proposal to move a skill or a memory up a level, decided by the company policy.
CREATE TABLE promotions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('skill', 'memory')),
  subject_id     uuid NOT NULL,
  from_scope     text NOT NULL CHECK (from_scope IN ('agent', 'team')),
  to_scope       text NOT NULL CHECK (to_scope IN ('team', 'company')),
  status         text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'denied', 'applied', 'forbidden')),
  -- The approval a person decides, when the policy asks for a review.
  approval_id    uuid REFERENCES approvals(id) ON DELETE SET NULL,
  -- Why: uses, outcomes, the tasks it worked in.
  evidence       jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- The new, promoted entry.
  result_id      uuid,
  proposed_by_kind text NOT NULL DEFAULT 'system' CHECK (proposed_by_kind IN ('person', 'agent', 'system')),
  proposed_by_id uuid,
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX promotions_company_idx ON promotions (company_id, status);
CREATE INDEX promotions_subject_idx ON promotions (subject_id, status);
CREATE TRIGGER promotions_updated_at BEFORE UPDATE ON promotions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A copy of the skills before every curator pass, so nothing is ever lost.
CREATE TABLE learning_backups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('curator')),
  payload      jsonb NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX learning_backups_company_idx ON learning_backups (company_id, created_at DESC);
CREATE TRIGGER learning_backups_updated_at BEFORE UPDATE ON learning_backups FOR EACH ROW EXECUTE FUNCTION set_updated_at();
