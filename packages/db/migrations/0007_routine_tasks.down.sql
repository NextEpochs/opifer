DROP INDEX IF EXISTS routine_runs_task_idx;
ALTER TABLE routine_runs DROP COLUMN task_id;
ALTER TABLE routines DROP COLUMN mode;
