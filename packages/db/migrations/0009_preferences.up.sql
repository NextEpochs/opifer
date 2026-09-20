-- 0009 Interface preferences per person (view mode, theme, language, board
-- layouts), kept on the server so they follow the person across browsers.
-- In local mode there is one person: user_id is null.

CREATE TABLE user_preferences (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid REFERENCES users(id) ON DELETE CASCADE,
  key         text NOT NULL,
  value       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX user_preferences_key_idx ON user_preferences (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid), key);
CREATE TRIGGER user_preferences_updated_at BEFORE UPDATE ON user_preferences FOR EACH ROW EXECUTE FUNCTION set_updated_at();
