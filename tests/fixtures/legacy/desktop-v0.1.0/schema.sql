PRAGMA user_version = 0;
PRAGMA foreign_keys = OFF;

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  preset_id TEXT,
  provider_label TEXT NOT NULL,
  protocol TEXT NOT NULL,
  base_url TEXT NOT NULL,
  model TEXT NOT NULL,
  source_url TEXT,
  policy_note TEXT,
  include_anthropic_version_header INTEGER NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  last_test_status TEXT,
  last_test_error TEXT,
  last_tested_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE writing_projects (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL,
  topic TEXT NOT NULL,
  audience TEXT NOT NULL,
  word_target INTEGER,
  style_profile_id TEXT,
  model_profile_id TEXT NOT NULL,
  current_stage TEXT NOT NULL,
  status TEXT NOT NULL,
  is_archived INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  workspace_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stage_outputs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  stage_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  summary TEXT,
  word_count INTEGER NOT NULL DEFAULT 0,
  markdown TEXT NOT NULL,
  structured_json TEXT NOT NULL,
  raw_text TEXT,
  artifact_path TEXT NOT NULL,
  status TEXT NOT NULL,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE exports (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
