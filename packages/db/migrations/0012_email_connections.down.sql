DELETE FROM tool_connections WHERE kind = 'email';
ALTER TABLE tool_connections DROP CONSTRAINT tool_connections_kind_check;
ALTER TABLE tool_connections ADD CONSTRAINT tool_connections_kind_check CHECK (kind IN ('mcp_stdio', 'mcp_http', 'workflow'));
