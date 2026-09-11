ALTER TABLE persons ADD CONSTRAINT persons_id_owner_key UNIQUE (id, user_id);
ALTER TABLE questions ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE questions ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE interpretations ADD COLUMN is_active boolean NOT NULL DEFAULT true;
ALTER TABLE interpretations ADD COLUMN active_version integer;
UPDATE interpretations i SET active_version = (
  SELECT max(v.version) FROM interpretation_versions v WHERE v.interpretation_id = i.id
);
ALTER TABLE interpretations ADD CONSTRAINT interpretations_active_version_fk
  FOREIGN KEY (id, active_version) REFERENCES interpretation_versions(interpretation_id, version)
  ON UPDATE RESTRICT ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION bump_question_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.prompt, NEW.relationship_code, NEW.is_custom_template, NEW.is_active)
    IS DISTINCT FROM (OLD.prompt, OLD.relationship_code, OLD.is_custom_template, OLD.is_active) THEN
    NEW.version := OLD.version + 1;
  ELSIF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'question version cannot decrease';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER questions_version BEFORE UPDATE ON questions
  FOR EACH ROW EXECUTE FUNCTION bump_question_version();

CREATE FUNCTION bump_position_question_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE questions SET version = version + 1 WHERE id = OLD.question_id;
  END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.question_id IS DISTINCT FROM OLD.question_id) THEN
    UPDATE questions SET version = version + 1 WHERE id = NEW.question_id;
  END IF;
  RETURN NULL;
END;
$$;
CREATE TRIGGER card_positions_version AFTER INSERT OR UPDATE OR DELETE ON card_positions
  FOR EACH ROW EXECUTE FUNCTION bump_position_question_version();

CREATE FUNCTION preserve_interpretation_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'interpretation versions are immutable'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER interpretation_versions_immutable BEFORE UPDATE ON interpretation_versions
  FOR EACH ROW EXECUTE FUNCTION preserve_interpretation_version();

CREATE TABLE readings (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  person_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  current_attempt_no integer NOT NULL CHECK (current_attempt_no BETWEEN 1 AND 3),
  request_snapshot jsonb NOT NULL,
  result_json jsonb,
  error_json jsonb,
  ai_generated boolean NOT NULL DEFAULT false,
  contract_version text NOT NULL,
  prompt_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (person_id, user_id) REFERENCES persons(id, user_id) ON UPDATE RESTRICT ON DELETE CASCADE,
  UNIQUE (id, user_id)
);
CREATE UNIQUE INDEX readings_one_active_user ON readings(user_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX readings_owner_history ON readings(user_id, person_id, created_at DESC, id DESC);
CREATE INDEX readings_queue ON readings(created_at, id) WHERE status = 'QUEUED';

CREATE TABLE reading_cards (
  id uuid PRIMARY KEY,
  reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  card_id uuid NOT NULL REFERENCES tarot_cards(id) ON UPDATE RESTRICT ON DELETE RESTRICT,
  position_index integer NOT NULL CHECK (position_index BETWEEN 1 AND 3),
  card_snapshot jsonb NOT NULL,
  position_snapshot jsonb NOT NULL,
  UNIQUE (reading_id, card_id),
  UNIQUE (reading_id, position_index)
);
CREATE TABLE reading_evidence (
  reading_card_id uuid NOT NULL REFERENCES reading_cards(id) ON DELETE CASCADE,
  interpretation_id uuid NOT NULL,
  version integer NOT NULL,
  text_snapshot text NOT NULL,
  metadata_snapshot jsonb NOT NULL,
  selected boolean NOT NULL DEFAULT false,
  PRIMARY KEY (reading_card_id, interpretation_id, version),
  FOREIGN KEY (interpretation_id, version) REFERENCES interpretation_versions(interpretation_id, version)
    ON UPDATE RESTRICT ON DELETE RESTRICT
);
CREATE TABLE reading_attempts (
  id uuid PRIMARY KEY,
  reading_id uuid NOT NULL REFERENCES readings(id) ON DELETE CASCADE,
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  status text NOT NULL CHECK (status IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED')),
  queued_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  error_json jsonb,
  provider text,
  model text,
  usage jsonb,
  UNIQUE (reading_id, attempt_no),
  UNIQUE (reading_id, id)
);
CREATE UNIQUE INDEX attempts_one_active_reading ON reading_attempts(reading_id) WHERE status IN ('QUEUED', 'RUNNING');
CREATE INDEX attempts_expiry ON reading_attempts(lease_expires_at) WHERE status = 'RUNNING';
ALTER TABLE readings ADD CONSTRAINT readings_current_attempt_fk
  FOREIGN KEY (id, current_attempt_no) REFERENCES reading_attempts(reading_id, attempt_no)
  DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE idempotency_requests (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  operation text NOT NULL,
  key uuid NOT NULL,
  request_hash char(64) NOT NULL,
  reading_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, operation, key),
  FOREIGN KEY (reading_id, user_id) REFERENCES readings(id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (reading_id, attempt_id) REFERENCES reading_attempts(reading_id, id) ON DELETE CASCADE
);
