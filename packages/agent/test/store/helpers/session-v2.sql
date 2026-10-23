CREATE TABLE session (
  id TEXT PRIMARY KEY, parent_id TEXT, role TEXT,
  lease_owner TEXT, lease_fence INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'idle',
  tools_generation INTEGER NOT NULL DEFAULT 0, system_hash TEXT NOT NULL DEFAULT '',
  policy_generation INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE action (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES action(id),
  session_id TEXT NOT NULL REFERENCES session(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, intent TEXT NOT NULL CHECK (json_valid(intent)),
  effect TEXT NOT NULL CHECK (json_valid(effect)),
  revert TEXT CHECK (revert IS NULL OR json_valid(revert)),
  irreversible INTEGER NOT NULL CHECK (irreversible IN (0, 1)),
  encoding_version INTEGER NOT NULL CHECK (encoding_version = 1),
  ts INTEGER NOT NULL CHECK (ts >= 0), ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  prev_hash TEXT NOT NULL, action_hash TEXT NOT NULL,
  CHECK ((revert IS NOT NULL) <> (irreversible = 1)), UNIQUE (session_id, ordinal)
);
CREATE UNIQUE INDEX action_hash_unique ON action(action_hash);
CREATE TABLE decision_fact (
  key TEXT PRIMARY KEY, type TEXT NOT NULL, data TEXT NOT NULL,
  row_hash TEXT NOT NULL, time_created INTEGER NOT NULL
);
CREATE TABLE armed_alarms (
  alarm_id TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL UNIQUE,
  fire_at INTEGER NOT NULL, strikes INTEGER NOT NULL DEFAULT 0
);
INSERT INTO session (id, role, revision) VALUES ('legacy', 'resident', 2);
INSERT INTO action VALUES
  ('first', NULL, 'legacy', 'prompt', '{"source":"test"}',
   '{"deliveryKind":"prompt","content":"first"}', NULL, 1, 1, 10, 1, 'genesis', 'digest-1'),
  ('second', 'first', 'legacy', 'tool', '{"op":"read"}',
   '{"result":"kept"}', '{"undo":"kept"}', 0, 1, 20, 2, 'digest-1', 'digest-2');
INSERT INTO decision_fact VALUES ('fact', 'test', '{"kept":true}', 'fact-digest', 30);
INSERT INTO armed_alarms VALUES ('alarm', 'occurrence', 40, 2);
PRAGMA user_version = 2;
