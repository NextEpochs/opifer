-- 0002 Sessions: back to the foundations schema.

DROP TRIGGER IF EXISTS run_events_updated_at ON run_events;
DROP TABLE IF EXISTS run_events;

DROP TRIGGER IF EXISTS messages_alternate ON messages;
DROP FUNCTION IF EXISTS messages_roles_alternate();
DROP TRIGGER IF EXISTS messages_updated_at ON messages;
DROP TABLE IF EXISTS messages;

DROP TRIGGER IF EXISTS runs_updated_at ON runs;
DROP TABLE IF EXISTS runs;

DROP TRIGGER IF EXISTS sessions_stable_prefix ON sessions;
DROP FUNCTION IF EXISTS sessions_system_prompt_is_stable();
DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
DROP TABLE IF EXISTS sessions;
