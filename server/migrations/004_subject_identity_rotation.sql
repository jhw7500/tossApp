CREATE TABLE user_subject_identities (
  subject_hash char(64) PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key_version text NOT NULL CHECK (key_version <> '' AND length(key_version) <= 64),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_subject_identities_user_idx ON user_subject_identities(user_id);

CREATE FUNCTION tarororo_capture_inserted_user_subject_identity()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO user_subject_identities (subject_hash, user_id, key_version)
  VALUES (NEW.subject_hash, NEW.id, 'legacy');
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_capture_subject_identity
AFTER INSERT ON users
FOR EACH ROW
EXECUTE FUNCTION tarororo_capture_inserted_user_subject_identity();

INSERT INTO user_subject_identities (subject_hash, user_id, key_version)
SELECT subject_hash, id, 'legacy'
FROM users;
