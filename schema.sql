
CREATE TABLE giveaways (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT,
  status TEXT NOT NULL,            -- open | closed | ended | saved
  opened_at INTEGER,
  expires_at INTEGER,
  ended_at INTEGER
);

CREATE TABLE system_config (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- One permanent record per Mobile Legends account (User ID + Server ID).
CREATE TABLE players (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tracking_id TEXT NOT NULL,              -- e.g. SW-7K4Q9, streamer side only
  tracking_lower TEXT NOT NULL UNIQUE,
  ml_user_id TEXT NOT NULL,
  ml_server_id TEXT NOT NULL,
  ign TEXT NOT NULL,                      -- current display name
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'scan',    -- scan | manual-review | host
  created_at INTEGER NOT NULL,
  UNIQUE (ml_user_id, ml_server_id)
);
CREATE INDEX idx_players_tiktok ON players (tiktok_lower);
CREATE INDEX idx_players_uid ON players (ml_user_id);

-- A player on a giveaway's wheel. tiktok_lower holds the player's tracking_lower.
CREATE TABLE qualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL,
  roblox_username TEXT NOT NULL,          -- display name on the wheel (IGN)
  roblox_lower TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL,
  level INTEGER NOT NULL DEFAULT 0,
  device_hash TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',  -- active | eliminated | winner
  source TEXT NOT NULL DEFAULT 'ocr',     -- ocr | self | registered | manual | manual-approved
  created_at INTEGER NOT NULL,
  UNIQUE (giveaway_id, roblox_lower),
  UNIQUE (giveaway_id, tiktok_lower)
);

CREATE TABLE disqualified_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL,
  roblox_username TEXT NOT NULL,
  roblox_lower TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL,
  reason TEXT,
  device_hash TEXT,
  disqualified_at INTEGER NOT NULL
);

CREATE TABLE manual_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giveaway_id INTEGER NOT NULL,
  roblox_username TEXT NOT NULL,
  roblox_lower TEXT NOT NULL,
  tiktok_username TEXT NOT NULL,
  tiktok_lower TEXT NOT NULL,
  ml_user_id TEXT NOT NULL DEFAULT '',
  ml_server_id TEXT NOT NULL DEFAULT '',
  note TEXT,
  reason TEXT,
  ocr_excerpt TEXT,
  device_hash TEXT,
  screenshot TEXT,
  check_key TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);

-- Display-name and TikTok @username change requests, approved or rejected by the host in the notification panel.
CREATE TABLE name_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  player_id INTEGER NOT NULL,
  kind TEXT NOT NULL DEFAULT 'name',      -- name | tiktok
  old_name TEXT NOT NULL,
  new_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reject_reason TEXT,
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_name_requests_player ON name_requests (player_id, status);

-- Wrong-try limiter for the Enter tab (per device).
CREATE TABLE login_attempts (
  device_hash TEXT PRIMARY KEY,
  fails INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- Message limiter for the helper bot (per device).
CREATE TABLE bot_usage (
  device_hash TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

CREATE TABLE permanent_blacklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  username_lower TEXT NOT NULL UNIQUE,
  reason TEXT,
  banned_at INTEGER NOT NULL
);

CREATE TABLE live_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
