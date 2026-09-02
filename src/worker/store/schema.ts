/**
 * The schema this build creates and migrates to.
 *
 * 9 stores dedup keys in compact form. That one does have to lock older
 * builds out: they compute the readable key, would not find the compact row it
 * belongs to, and would insert a second copy of turns they re-read — double
 * counting the tokens rather than replacing them.
 *
 * Dropping the two redundant indexes, by contrast, did NOT bump this. Nothing
 * reads an index by name — SQLite chooses them — so that change cannot affect
 * an older build and is applied as maintenance on every open instead.
 */
export const SCHEMA_VERSION = 9;

/**
 * The schema this build marks a database with once retention has pruned it.
 *
 * Structurally identical to 9. The number exists purely to stop a build that
 * predates retention from opening it: those builds compare every raw row
 * against every aggregate, conclude a pruned database is corrupt, and rebuild
 * the aggregates from rows that no longer exist — deleting the history
 * retention was designed to keep. A database only reaches this version if the
 * user turns retention on, and a reset puts it back to SCHEMA_VERSION.
 */
export const PRUNED_SCHEMA_VERSION = 10;

/** The highest schema this build can safely read. */
export const MAX_READABLE_SCHEMA = PRUNED_SCHEMA_VERSION;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS usage_record (
  dedup_key            TEXT PRIMARY KEY,
  file_id              TEXT NOT NULL,
  source               TEXT NOT NULL,
  session_id           TEXT NOT NULL,
  ts_utc               INTEGER NOT NULL,
  day_local            TEXT NOT NULL,
  dow_local            INTEGER NOT NULL,
  hour_local           INTEGER NOT NULL,
  model                TEXT NOT NULL,
  effort               TEXT NOT NULL,
  variant_id           TEXT NOT NULL,
  workspace            TEXT NOT NULL DEFAULT '',
  input_tokens         INTEGER NOT NULL DEFAULT 0,
  output_tokens        INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens         INTEGER NOT NULL DEFAULT 0,
  context_window       INTEGER,
  context_used_tokens  INTEGER,
  is_sidechain         INTEGER NOT NULL DEFAULT 0,
  stop_reason          TEXT,
  cost_usd             REAL NOT NULL DEFAULT 0,
  cost_unknown         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_rec_ts ON usage_record(ts_utc);
CREATE INDEX IF NOT EXISTS idx_rec_file ON usage_record(file_id);
-- (source, session_id) and (day_local) are deliberately absent: each is a
-- leading prefix of one of the indexes below, so SQLite answers those lookups
-- from the wider index with the same access path. Carrying them cost 10.9 MB
-- of index on a 122 MB database and bought nothing.
CREATE INDEX IF NOT EXISTS idx_rec_session_model ON usage_record(source, session_id, model);
CREATE INDEX IF NOT EXISTS idx_rec_daily_key ON usage_record(day_local, source, variant_id, workspace);

CREATE TABLE IF NOT EXISTS tool_event (
  event_key        TEXT PRIMARY KEY,
  record_dedup_key TEXT NOT NULL,
  file_id          TEXT NOT NULL,
  source           TEXT NOT NULL,
  session_id       TEXT NOT NULL,
  ts_utc           INTEGER NOT NULL,
  day_local        TEXT NOT NULL,
  tool_name        TEXT NOT NULL,
  model            TEXT NOT NULL,
  variant_id       TEXT NOT NULL,
  workspace        TEXT NOT NULL DEFAULT '',
  is_sidechain     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tool_file ON tool_event(file_id);
CREATE INDEX IF NOT EXISTS idx_tool_day ON tool_event(day_local, source);
CREATE INDEX IF NOT EXISTS idx_tool_record ON tool_event(record_dedup_key);

CREATE TABLE IF NOT EXISTS daily_aggregate (
  day_local             TEXT NOT NULL,
  source                TEXT NOT NULL,
  variant_id            TEXT NOT NULL,
  base_model            TEXT NOT NULL,
  workspace             TEXT NOT NULL DEFAULT '',
  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens      INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  turns                 INTEGER NOT NULL DEFAULT 0,
  cost_usd              REAL NOT NULL DEFAULT 0,
  unknown_cost_turns    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day_local, source, variant_id, workspace)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_aggregate(day_local);

CREATE TABLE IF NOT EXISTS session_aggregate (
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  workspace         TEXT NOT NULL DEFAULT '',
  first_ts_utc      INTEGER NOT NULL,
  last_ts_utc       INTEGER NOT NULL,
  turns             INTEGER NOT NULL DEFAULT 0,
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,
  peak_context_fill REAL,
  sidechain_tokens  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id)
);

CREATE TABLE IF NOT EXISTS file_cursor (
  file_path        TEXT PRIMARY KEY,
  file_id          TEXT NOT NULL,
  source           TEXT NOT NULL,
  size             INTEGER NOT NULL,
  mtime_ms         INTEGER NOT NULL,
  last_byte_offset INTEGER NOT NULL,
  head_hash        TEXT NOT NULL,
  tail_anchor_hash TEXT NOT NULL,
  running_totals   TEXT NOT NULL,
  recent_req_ids   TEXT NOT NULL,
  contribution     TEXT NOT NULL,
  parse_revision   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS file_catalog (
  file_path         TEXT PRIMARY KEY,
  file_id           TEXT NOT NULL,
  source            TEXT NOT NULL,
  size              INTEGER NOT NULL,
  mtime_ms          INTEGER NOT NULL,
  first_seen_utc    INTEGER NOT NULL,
  last_seen_utc     INTEGER NOT NULL,
  last_changed_utc  INTEGER NOT NULL,
  last_checked_utc  INTEGER,
  last_ingested_utc INTEGER,
  min_day           TEXT,
  max_day           TEXT,
  state             TEXT NOT NULL,
  priority_score    REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_file_catalog_hot
  ON file_catalog(source, state, priority_score, last_changed_utc, mtime_ms);
CREATE INDEX IF NOT EXISTS idx_file_catalog_days
  ON file_catalog(max_day, min_day);

CREATE TABLE IF NOT EXISTS pricing (
  model      TEXT PRIMARY KEY,
  rates_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS unmapped_model (
  model          TEXT PRIMARY KEY,
  first_seen_utc INTEGER NOT NULL
);
`;
