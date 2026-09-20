-- 0008 Context management: the only change ever made to a session's past is
-- a compression, done at a threshold and traced here. Messages are never
-- deleted: the session records from which sequence number the model sees a
-- summary instead of the originals.

ALTER TABLE sessions ADD COLUMN context_from_seq integer NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN context_summary text;

CREATE TABLE session_compressions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  session_id    uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  run_id        uuid REFERENCES runs(id) ON DELETE SET NULL,
  -- Messages with seq in (from_seq, to_seq] were summarised; from_seq is the previous boundary.
  from_seq      integer NOT NULL,
  to_seq        integer NOT NULL,
  -- model: the auxiliary model wrote the summary; deterministic: the fallback outline.
  method        text NOT NULL CHECK (method IN ('model', 'deterministic')),
  chars_before  integer NOT NULL,
  chars_after   integer NOT NULL,
  summary       text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX session_compressions_session_idx ON session_compressions (session_id, created_at);
CREATE TRIGGER session_compressions_updated_at BEFORE UPDATE ON session_compressions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
