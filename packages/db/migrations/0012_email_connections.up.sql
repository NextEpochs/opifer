-- 0012 Email as a connection kind: a mailbox (SMTP + IMAP) the agents send from
-- and read, the password a company secret.

ALTER TABLE tool_connections DROP CONSTRAINT tool_connections_kind_check;
ALTER TABLE tool_connections ADD CONSTRAINT tool_connections_kind_check CHECK (kind IN ('mcp_stdio', 'mcp_http', 'workflow', 'email'));
