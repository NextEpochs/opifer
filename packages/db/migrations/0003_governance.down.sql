-- 0003 Governance: back to the sessions schema.

DROP TRIGGER IF EXISTS secret_access_events_updated_at ON secret_access_events;
DROP TABLE IF EXISTS secret_access_events;
DROP TRIGGER IF EXISTS secret_bindings_updated_at ON secret_bindings;
DROP TABLE IF EXISTS secret_bindings;
DROP TRIGGER IF EXISTS secrets_updated_at ON secrets;
DROP TABLE IF EXISTS secrets;
DROP TRIGGER IF EXISTS tool_policies_updated_at ON tool_policies;
DROP TABLE IF EXISTS tool_policies;
DROP TRIGGER IF EXISTS approvals_updated_at ON approvals;
DROP TABLE IF EXISTS approvals;
DROP TRIGGER IF EXISTS budget_reservations_updated_at ON budget_reservations;
DROP TABLE IF EXISTS budget_reservations;
DROP TRIGGER IF EXISTS cost_events_updated_at ON cost_events;
DROP TABLE IF EXISTS cost_events;
DROP TRIGGER IF EXISTS budget_policies_updated_at ON budget_policies;
DROP TABLE IF EXISTS budget_policies;
