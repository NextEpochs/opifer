-- 0001 Fondamenta: ritorno allo schema vuoto.

DROP TRIGGER IF EXISTS agent_revisions_updated_at ON agent_revisions;
DROP TRIGGER IF EXISTS agents_updated_at ON agents;
DROP TRIGGER IF EXISTS memberships_updated_at ON memberships;
DROP TRIGGER IF EXISTS users_updated_at ON users;
DROP TRIGGER IF EXISTS companies_updated_at ON companies;
DROP FUNCTION IF EXISTS set_updated_at();

DROP TRIGGER IF EXISTS audit_log_no_update_no_delete ON audit_log;
DROP FUNCTION IF EXISTS audit_log_is_append_only();

DROP TABLE IF EXISTS audit_log;
DROP TABLE IF EXISTS agent_revisions;
DROP TABLE IF EXISTS agents;
DROP TABLE IF EXISTS memberships;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS companies;
