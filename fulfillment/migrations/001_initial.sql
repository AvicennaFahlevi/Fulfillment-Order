-- Private schema: application authentication remains in Express, not Supabase Auth.
-- TEXT identifiers, timestamps and JSON preserve the existing API representation.
CREATE TABLE fulfill.users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'picker', 'packer')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE fulfill.sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES fulfill.users(id),
  expires_at BIGINT NOT NULL
);
CREATE INDEX sessions_user ON fulfill.sessions(user_id);
CREATE INDEX sessions_expiry ON fulfill.sessions(expires_at);

CREATE TABLE fulfill.orders (
  id TEXT PRIMARY KEY,
  tracking TEXT NOT NULL UNIQUE,
  order_number TEXT NOT NULL,
  buyer TEXT NOT NULL,
  recipient TEXT NOT NULL,
  source_status TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('NEW', 'READY', 'PACKING', 'PACKED')),
  items TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  picked_by TEXT REFERENCES fulfill.users(id),
  picked_at TEXT,
  picked_input_version INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE fulfill.recordings (
  id TEXT PRIMARY KEY,
  tracking TEXT NOT NULL REFERENCES fulfill.orders(tracking),
  order_number TEXT NOT NULL,
  packer_id TEXT NOT NULL REFERENCES fulfill.users(id),
  station TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RECORDING', 'SAVED', 'INTERRUPTED', 'FAILED')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  duration DOUBLE PRECISION NOT NULL DEFAULT 0,
  bytes BIGINT NOT NULL DEFAULT 0,
  drive_file_id TEXT,
  reason TEXT,
  client_id TEXT NOT NULL UNIQUE
);
CREATE UNIQUE INDEX one_active_recording ON fulfill.recordings(tracking) WHERE status = 'RECORDING';
CREATE INDEX orders_picker ON fulfill.orders(picked_by);
CREATE INDEX recordings_tracking ON fulfill.recordings(tracking);
CREATE INDEX recordings_packer ON fulfill.recordings(packer_id);

REVOKE ALL ON ALL TABLES IN SCHEMA fulfill FROM PUBLIC;
