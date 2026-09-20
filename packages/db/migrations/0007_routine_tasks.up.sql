-- 0007 Routines that run as tasks: each due time creates a task for the agent
-- instead of a bare session, so the run can delegate to reports, be reviewed
-- and verified like any other work. The run closes when the task closes.

ALTER TABLE routines ADD COLUMN mode text NOT NULL DEFAULT 'session' CHECK (mode IN ('session', 'task'));
ALTER TABLE routine_runs ADD COLUMN task_id uuid REFERENCES tasks(id) ON DELETE SET NULL;
CREATE INDEX routine_runs_task_idx ON routine_runs (task_id) WHERE task_id IS NOT NULL;
