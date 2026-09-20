-- 0004 Work: goals, projects, tasks with atomic checkout, comments, relations, results, wake-ups.

-- Objectives as a tree, from the mission down to measurable results.
CREATE TABLE goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  parent_id    uuid REFERENCES goals(id) ON DELETE CASCADE,
  title        text NOT NULL,
  description  text NOT NULL DEFAULT '',
  -- How we know it is reached: a number, a date, a deliverable.
  measure      text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reached', 'dropped')),
  due_at       timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX goals_company_idx ON goals (company_id, parent_id);
CREATE TRIGGER goals_updated_at BEFORE UPDATE ON goals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Projects group tasks and serve goals; their budget is a budget_policies row with scope 'project'.
CREATE TABLE projects (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  goal_id      uuid REFERENCES goals(id) ON DELETE SET NULL,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  status       text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'done', 'archived')),
  -- Folder the project's tasks work in; NULL means one folder per task.
  workdir      text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name)
);

CREATE INDEX projects_company_idx ON projects (company_id);
CREATE TRIGGER projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One responsible per task. The checkout to in_progress is the only transition
-- that needs the atomic lease; the lease is kept alive by heartbeats.
CREATE TABLE tasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id           uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  project_id           uuid REFERENCES projects(id) ON DELETE SET NULL,
  goal_id              uuid REFERENCES goals(id) ON DELETE SET NULL,
  parent_id            uuid REFERENCES tasks(id) ON DELETE CASCADE,
  title                text NOT NULL,
  description          text NOT NULL DEFAULT '',
  -- Definition of done: what makes the result verifiable.
  acceptance           text NOT NULL DEFAULT '',
  status               text NOT NULL DEFAULT 'todo'
                       CHECK (status IN ('todo', 'in_progress', 'in_review', 'blocked', 'done', 'cancelled')),
  priority             text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  assignee_agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  assignee_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewer_agent_id    uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_by_kind      text NOT NULL DEFAULT 'person' CHECK (created_by_kind IN ('person', 'agent', 'system')),
  created_by_id        uuid,
  due_at               timestamptz,
  -- The lease: who holds the task and until when. Renewed by heartbeats.
  lease_run_id         uuid REFERENCES runs(id) ON DELETE SET NULL,
  lease_session_id     uuid REFERENCES sessions(id) ON DELETE SET NULL,
  lease_expires_at     timestamptz,
  checked_out_at       timestamptz,
  -- Consecutive failed attempts; past the threshold the task blocks and asks for help.
  failures             integer NOT NULL DEFAULT 0,
  blocked_reason       text,
  -- The verifiable result the task closed with (also mirrored in work_products).
  result               jsonb,
  started_at           timestamptz,
  finished_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (assignee_agent_id IS NULL OR assignee_user_id IS NULL)
);

CREATE INDEX tasks_company_status_idx ON tasks (company_id, status, priority);
CREATE INDEX tasks_assignee_idx ON tasks (assignee_agent_id, status);
CREATE INDEX tasks_parent_idx ON tasks (parent_id);
CREATE INDEX tasks_project_idx ON tasks (project_id);
CREATE INDEX tasks_lease_idx ON tasks (lease_expires_at) WHERE status = 'in_progress';
CREATE TRIGGER tasks_updated_at BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A task closes with a verifiable result, never with a status message.
CREATE FUNCTION tasks_done_means_verified() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'done' AND (NEW.result IS NULL OR NEW.result = 'null'::jsonb OR coalesce(NEW.result->>'summary', '') = '') THEN
    RAISE EXCEPTION 'a task is done only with a verifiable result (done means verified)'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tasks_done_needs_result BEFORE INSERT OR UPDATE OF status, result ON tasks
  FOR EACH ROW EXECUTE FUNCTION tasks_done_means_verified();

-- Comments are the one channel of discussion on work; a mention wakes the agent.
CREATE TABLE task_comments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_kind  text NOT NULL CHECK (author_kind IN ('person', 'agent', 'system')),
  author_id    uuid,
  body         text NOT NULL,
  -- Agent ids mentioned in the body (@Name resolved at write time).
  mentions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX task_comments_task_idx ON task_comments (task_id, created_at);
CREATE TRIGGER task_comments_updated_at BEFORE UPDATE ON task_comments FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Dependencies and blocks between tasks.
CREATE TABLE task_relations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  related_id   uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('depends_on', 'blocks', 'relates_to')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id, related_id, kind),
  CHECK (task_id <> related_id)
);

CREATE INDEX task_relations_company_idx ON task_relations (company_id);
CREATE TRIGGER task_relations_updated_at BEFORE UPDATE ON task_relations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Results are first-class: files, links, diffs, documents, decisions.
CREATE TABLE work_products (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  task_id      uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id       uuid REFERENCES runs(id) ON DELETE SET NULL,
  kind         text NOT NULL CHECK (kind IN ('file', 'link', 'diff', 'document', 'decision', 'note')),
  title        text NOT NULL,
  -- Path, URL or inline content depending on the kind.
  ref          text NOT NULL DEFAULT '',
  summary      text NOT NULL DEFAULT '',
  created_by_kind text NOT NULL DEFAULT 'agent' CHECK (created_by_kind IN ('person', 'agent', 'system')),
  created_by_id   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX work_products_task_idx ON work_products (task_id, created_at);
CREATE TRIGGER work_products_updated_at BEFORE UPDATE ON work_products FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Why an agent wakes up. Claimed at most once; a dedupe key collapses repeats while pending.
CREATE TABLE wakeups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  agent_id      uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  reason        text NOT NULL CHECK (reason IN ('assignment', 'mention', 'heartbeat', 'routine', 'external', 'decision', 'retry')),
  task_id       uuid REFERENCES tasks(id) ON DELETE CASCADE,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key    text,
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed', 'skipped')),
  scheduled_at  timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  finished_at   timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX wakeups_pending_idx ON wakeups (scheduled_at) WHERE status = 'pending';
CREATE UNIQUE INDEX wakeups_dedupe_idx ON wakeups (company_id, dedupe_key) WHERE status = 'pending' AND dedupe_key IS NOT NULL;
CREATE TRIGGER wakeups_updated_at BEFORE UPDATE ON wakeups FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A session can belong to a task (kind 'task'); the task's chain enters the prompt.
ALTER TABLE sessions ADD COLUMN task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX sessions_task_idx ON sessions (task_id);
