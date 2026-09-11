CREATE TABLE schema_migrations (
  name text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE relationship_types (
  code text PRIMARY KEY,
  label text NOT NULL,
  sort_order integer NOT NULL UNIQUE
);

CREATE TABLE users (
  id uuid PRIMARY KEY,
  subject_hash char(64) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_active_token_idx ON sessions(token_hash) WHERE revoked_at IS NULL;

CREATE TABLE persons (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname text NOT NULL,
  relationship_code text NOT NULL REFERENCES relationship_types(code),
  current_situation text,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX persons_owner_created_idx ON persons(user_id, created_at DESC, id DESC);

CREATE TABLE questions (
  id uuid PRIMARY KEY,
  relationship_code text NOT NULL REFERENCES relationship_types(code),
  prompt text NOT NULL,
  is_custom_template boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (relationship_code, sort_order)
);

CREATE TABLE card_positions (
  id uuid PRIMARY KEY,
  question_id uuid NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position IN (1, 2, 3)),
  label text NOT NULL,
  description text,
  UNIQUE(question_id, position)
);

CREATE TABLE tarot_cards (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  arcana text NOT NULL,
  image_url text,
  is_selectable boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE interpretations (
  id uuid PRIMARY KEY,
  tarot_card_id uuid NOT NULL REFERENCES tarot_cards(id) ON DELETE CASCADE,
  locale text NOT NULL DEFAULT 'ko-KR',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(tarot_card_id, locale)
);

CREATE TABLE interpretation_versions (
  id uuid PRIMARY KEY,
  interpretation_id uuid NOT NULL REFERENCES interpretations(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  content text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('synthetic_test', 'licensed', 'editorial')),
  source_attribution text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(interpretation_id, version)
);
