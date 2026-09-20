-- 0004 Work: back to the governance schema.

DROP INDEX IF EXISTS sessions_task_idx;
ALTER TABLE sessions DROP COLUMN IF EXISTS task_id;
DROP TRIGGER IF EXISTS wakeups_updated_at ON wakeups;
DROP TABLE IF EXISTS wakeups;
DROP TRIGGER IF EXISTS work_products_updated_at ON work_products;
DROP TABLE IF EXISTS work_products;
DROP TRIGGER IF EXISTS task_relations_updated_at ON task_relations;
DROP TABLE IF EXISTS task_relations;
DROP TRIGGER IF EXISTS task_comments_updated_at ON task_comments;
DROP TABLE IF EXISTS task_comments;
DROP TRIGGER IF EXISTS tasks_done_needs_result ON tasks;
DROP FUNCTION IF EXISTS tasks_done_means_verified();
DROP TRIGGER IF EXISTS tasks_updated_at ON tasks;
DROP TABLE IF EXISTS tasks;
DROP TRIGGER IF EXISTS projects_updated_at ON projects;
DROP TABLE IF EXISTS projects;
DROP TRIGGER IF EXISTS goals_updated_at ON goals;
DROP TABLE IF EXISTS goals;
