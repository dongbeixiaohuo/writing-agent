import type { DatabaseSync } from "node:sqlite";

export const APPLICATION_ID = 0x57414754;
export const CURRENT_SCHEMA_VERSION = 8;

export function createSchema(database: DatabaseSync, appliedAt: string): void {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_source TEXT NOT NULL CHECK (
        name_source IN ('placeholder', 'agent', 'manual', 'legacy')
      ),
      mode TEXT NOT NULL CHECK (mode IN ('quick', 'deep')),
      schema_version INTEGER NOT NULL,
      revision INTEGER NOT NULL,
      latest_body_version_id TEXT,
      current_title_version_id TEXT,
      current_evidence_version_id TEXT,
      current_brief_version_id TEXT,
      fact_gate_status TEXT NOT NULL CHECK (
        fact_gate_status IN ('not_checked', 'passed', 'blocked', 'error', 'stale')
      ),
      current_fact_snapshot_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE operations (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      command_type TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX operations_project_idx ON operations(project_id, created_at);

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX sessions_project_idx ON sessions(project_id, created_at);

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'running', 'waiting_user', 'paused', 'completed',
          'failed', 'cancelled', 'budget_exhausted', 'interrupted'
        )
      ),
      plan_version TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      last_committed_event_seq INTEGER NOT NULL,
      stop_reason TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX runs_project_idx ON runs(project_id, created_at);
    CREATE INDEX runs_session_idx ON runs(session_id, created_at);

    CREATE TABLE request_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      serialization_version TEXT NOT NULL,
      assembly_version TEXT NOT NULL,
      request_json TEXT NOT NULL,
      normalized_payload_json TEXT NOT NULL,
      tool_schemas_json TEXT NOT NULL,
      content_references_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      redactions_json TEXT NOT NULL,
      unreconstructable_fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, request_id)
    ) STRICT;

    CREATE INDEX request_snapshots_run_idx
      ON request_snapshots(run_id, created_at);

    CREATE TABLE runtime_operations (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('model_request', 'tool_call', 'major_revision')
      ),
      effect TEXT NOT NULL CHECK (
        effect IN ('read_only', 'local_idempotent', 'external_side_effect')
      ),
      input_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'prepared', 'dispatched', 'interrupted', 'completed', 'failed',
          'cancelled', 'abandoned', 'unknown_outcome'
        )
      ),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX runtime_operations_run_idx
      ON runtime_operations(run_id, created_at);

    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (
        source_kind IN ('pasted_text', 'utf8_file', 'web_snapshot', 'legacy_import')
      ),
      source_reference TEXT,
      role TEXT NOT NULL CHECK (
        role IN ('user_firsthand', 'source_verified', 'illustrative')
      ),
      trust_label TEXT NOT NULL CHECK (
        trust_label IN (
          'user_provided_untrusted', 'external_untrusted', 'legacy_unknown'
        )
      ),
      permission_scope TEXT NOT NULL CHECK (permission_scope = 'project_only'),
      content_version_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE(project_id, id)
    ) STRICT;

    CREATE INDEX materials_project_idx ON materials(project_id, imported_at);

    CREATE TABLE writing_brief_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      brief_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parent_version_id TEXT REFERENCES writing_brief_versions(id),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX writing_brief_versions_project_idx
      ON writing_brief_versions(project_id, created_event_seq);

    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (
        type IN (
          'brief', 'direction', 'style', 'author_voice', 'interaction',
          'budget', 'title'
        )
      ),
      value_json TEXT NOT NULL,
      scope TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      source_event_id TEXT,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      revoked_by TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX decisions_project_idx
      ON decisions(project_id, active, created_at);

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('body', 'outline', 'title', 'evidence', 'review', 'report')
      ),
      logical_key TEXT NOT NULL,
      latest_version_id TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(project_id, kind, logical_key)
    ) STRICT;

    CREATE TABLE artifact_versions (
      id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('body', 'outline', 'title', 'evidence', 'review', 'report')
      ),
      logical_key TEXT NOT NULL,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      parent_version_ids_json TEXT NOT NULL,
      reason TEXT NOT NULL,
      request_snapshot_id TEXT,
      created_event_seq INTEGER NOT NULL,
      operation_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX artifact_versions_project_idx
      ON artifact_versions(project_id, kind, logical_key, created_at);

    CREATE TABLE body_documents (
      artifact_version_id TEXT PRIMARY KEY
        REFERENCES artifact_versions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parser_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX body_documents_project_idx
      ON body_documents(project_id, created_at);

    CREATE TABLE revision_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      base_body_version_id TEXT NOT NULL
        REFERENCES artifact_versions(id) ON DELETE CASCADE,
      base_project_revision INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      edits_json TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      requested_by_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('proposed', 'accepted', 'rejected', 'conflicted', 'withdrawn')
      ),
      accepted_version_id TEXT REFERENCES artifact_versions(id),
      conflict_code TEXT CHECK (
        conflict_code IS NULL OR conflict_code IN ('REVISION_CONFLICT', 'LOCK_CONFLICT')
      ),
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE INDEX revision_proposals_project_idx
      ON revision_proposals(project_id, created_at);

    CREATE TABLE block_lock_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      block_id TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('lock', 'unlock')),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX block_lock_decisions_project_idx
      ON block_lock_decisions(project_id, block_id, created_event_seq);

    CREATE TABLE fact_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      body_version_id TEXT,
      title_version_id TEXT,
      evidence_version_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('passed', 'blocked', 'error')),
      assessment_json TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE TABLE fact_input_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      schema_version TEXT NOT NULL CHECK (schema_version = 'fact-check-v2'),
      policy_version TEXT NOT NULL,
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      body_hash TEXT NOT NULL,
      title_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      title_hash TEXT NOT NULL,
      distribution_copy_hash TEXT,
      evidence_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      evidence_hash TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX fact_input_snapshots_project_idx
      ON fact_input_snapshots(project_id, created_event_seq);

    CREATE TABLE fact_assessments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL UNIQUE
        REFERENCES fact_input_snapshots(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('passed', 'blocked')),
      payload_json TEXT NOT NULL,
      claims_hash TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      report_content TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX fact_assessments_project_idx
      ON fact_assessments(project_id, created_event_seq);

    CREATE TABLE fact_invalidations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES fact_input_snapshots(id),
      reason TEXT NOT NULL CHECK (
        reason IN (
          'body_version_changed', 'title_version_changed',
          'evidence_version_changed'
        )
      ),
      changed_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(snapshot_id, reason, changed_version_id)
    ) STRICT;

    CREATE INDEX fact_invalidations_project_idx
      ON fact_invalidations(project_id, created_event_seq);

    CREATE TABLE exports (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      input_hash TEXT NOT NULL,
      expected_project_revision INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('working_copy', 'publication')),
      format TEXT NOT NULL CHECK (format IN ('markdown', 'txt', 'html')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      body_hash TEXT NOT NULL,
      title_version_id TEXT REFERENCES artifact_versions(id),
      title_hash TEXT,
      distribution_copy_hash TEXT,
      evidence_version_id TEXT REFERENCES artifact_versions(id),
      evidence_hash TEXT,
      fact_snapshot_id TEXT REFERENCES fact_input_snapshots(id),
      assessment_id TEXT REFERENCES fact_assessments(id),
      policy_version TEXT,
      gate_status TEXT NOT NULL CHECK (
        gate_status IN ('not_checked', 'checking', 'passed', 'blocked', 'error', 'stale')
      ),
      relative_path TEXT NOT NULL,
      manifest_relative_path TEXT,
      content_text TEXT NOT NULL,
      manifest_content TEXT,
      content_hash TEXT NOT NULL,
      manifest_hash TEXT,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      manifest_byte_length INTEGER CHECK (
        manifest_byte_length IS NULL OR manifest_byte_length >= 0
      ),
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_event_seq INTEGER,
      completed_at TEXT,
      CHECK (
        (mode = 'working_copy' AND format = 'markdown') OR
        (mode = 'publication' AND format IN ('txt', 'html'))
      )
    ) STRICT;

    CREATE INDEX exports_project_idx ON exports(project_id, created_at);

    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      project_seq INTEGER NOT NULL,
      run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      UNIQUE(project_id, project_seq)
    ) STRICT;

    CREATE INDEX events_run_idx ON events(run_id, project_seq);

    CREATE TABLE provenance_edges (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (
        relation IN (
          'DERIVED_FROM', 'USES_MATERIAL', 'CHANGED_BY_DECISION',
          'REVIEWED_IN', 'CHECKED_IN', 'EXPORTED_AS'
        )
      ),
      to_id TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      event_seq INTEGER NOT NULL,
      evidence_ref TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX provenance_edges_project_idx
      ON provenance_edges(project_id, event_seq);

  `);
  database
    .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(CURRENT_SCHEMA_VERSION, appliedAt);
  database.exec(`
    PRAGMA application_id = ${APPLICATION_ID};
    PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
  `);
}

export function migrateSchema(
  database: DatabaseSync,
  fromVersion: number,
  appliedAt: string,
): void {
  if (
    fromVersion !== 1 &&
    fromVersion !== 2 &&
    fromVersion !== 3 &&
    fromVersion !== 4 &&
    fromVersion !== 5 &&
    fromVersion !== 6 &&
    fromVersion !== 7
  ) {
    throw new Error(`Unsupported schema migration from version ${fromVersion}`);
  }
  if (fromVersion === 1) {
    database.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX sessions_project_idx ON sessions(project_id, created_at);

    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (
        status IN (
          'queued', 'running', 'waiting_user', 'paused', 'completed',
          'failed', 'cancelled', 'budget_exhausted', 'interrupted'
        )
      ),
      plan_version TEXT NOT NULL,
      budget_json TEXT NOT NULL,
      usage_json TEXT NOT NULL,
      last_committed_event_seq INTEGER NOT NULL,
      stop_reason TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX runs_project_idx ON runs(project_id, created_at);
    CREATE INDEX runs_session_idx ON runs(session_id, created_at);

    CREATE TABLE request_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      adapter_version TEXT NOT NULL,
      serialization_version TEXT NOT NULL,
      assembly_version TEXT NOT NULL,
      request_json TEXT NOT NULL,
      normalized_payload_json TEXT NOT NULL,
      tool_schemas_json TEXT NOT NULL,
      content_references_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      schema_hash TEXT NOT NULL,
      redactions_json TEXT NOT NULL,
      unreconstructable_fields_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(run_id, request_id)
    ) STRICT;

    CREATE INDEX request_snapshots_run_idx
      ON request_snapshots(run_id, created_at);

    ALTER TABLE events ADD COLUMN run_id TEXT REFERENCES runs(id) ON DELETE CASCADE;
    CREATE INDEX events_run_idx ON events(run_id, project_seq);

    UPDATE projects SET schema_version = 2;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(2, appliedAt);
    database.exec("PRAGMA user_version = 2;");
  }

  if (fromVersion <= 2) {
    database.exec(`
    CREATE TABLE runtime_operations (
      operation_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (
        kind IN ('model_request', 'tool_call', 'major_revision')
      ),
      effect TEXT NOT NULL CHECK (
        effect IN ('read_only', 'local_idempotent', 'external_side_effect')
      ),
      input_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (
        state IN (
          'prepared', 'dispatched', 'interrupted', 'completed', 'failed',
          'cancelled', 'abandoned', 'unknown_outcome'
        )
      ),
      result_json TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL,
      dispatched_at TEXT,
      completed_at TEXT
    ) STRICT;

    CREATE INDEX runtime_operations_run_idx
      ON runtime_operations(run_id, created_at);

    UPDATE runs
       SET budget_json = '{"maxMajorRevisions":2,"maxModelRequests":24,"maxRetriesPerRequest":2,"maxToolCalls":32}'
     WHERE budget_json = 'null';
    UPDATE runs
       SET usage_json = '{"cacheReadTokens":0,"cost":null,"costKnown":true,"inputTokens":0,"majorRevisions":0,"missingUsageReports":0,"modelRequests":0,"outputTokens":0,"reasoningTokens":0,"retries":0,"toolCalls":0,"totalTokens":0,"usageReports":0}'
     WHERE usage_json = 'null';

    UPDATE projects SET schema_version = 3;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(3, appliedAt);
    database.exec("PRAGMA user_version = 3;");
  }

  if (fromVersion <= 3) {
    database.exec(`
    ALTER TABLE projects ADD COLUMN current_brief_version_id TEXT;

    CREATE TABLE materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (
        source_kind IN ('pasted_text', 'utf8_file', 'web_snapshot', 'legacy_import')
      ),
      source_reference TEXT,
      role TEXT NOT NULL CHECK (
        role IN ('user_firsthand', 'source_verified', 'illustrative')
      ),
      trust_label TEXT NOT NULL CHECK (
        trust_label IN (
          'user_provided_untrusted', 'external_untrusted', 'legacy_unknown'
        )
      ),
      permission_scope TEXT NOT NULL CHECK (permission_scope = 'project_only'),
      content_version_id TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE(project_id, id)
    ) STRICT;

    CREATE INDEX materials_project_idx ON materials(project_id, imported_at);

    CREATE TABLE writing_brief_versions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      brief_json TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      parent_version_id TEXT REFERENCES writing_brief_versions(id),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX writing_brief_versions_project_idx
      ON writing_brief_versions(project_id, created_event_seq);

    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (
        type IN (
          'brief', 'direction', 'style', 'author_voice', 'interaction',
          'budget', 'title'
        )
      ),
      value_json TEXT NOT NULL,
      scope TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      source_event_id TEXT,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      revoked_by TEXT,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX decisions_project_idx
      ON decisions(project_id, active, created_at);

    UPDATE projects SET schema_version = 4;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(4, appliedAt);
    database.exec("PRAGMA user_version = 4;");
  }

  if (fromVersion <= 4) {
    database.exec(`
    CREATE TABLE body_documents (
      artifact_version_id TEXT PRIMARY KEY
        REFERENCES artifact_versions(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      parser_version TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      document_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX body_documents_project_idx
      ON body_documents(project_id, created_at);

    CREATE TABLE revision_proposals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      base_body_version_id TEXT NOT NULL
        REFERENCES artifact_versions(id) ON DELETE CASCADE,
      base_project_revision INTEGER NOT NULL,
      instruction TEXT NOT NULL,
      constraints_json TEXT NOT NULL,
      edits_json TEXT NOT NULL,
      diff_json TEXT NOT NULL,
      requested_by_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (
        status IN ('proposed', 'accepted', 'rejected', 'conflicted', 'withdrawn')
      ),
      accepted_version_id TEXT REFERENCES artifact_versions(id),
      conflict_code TEXT CHECK (
        conflict_code IS NULL OR conflict_code IN ('REVISION_CONFLICT', 'LOCK_CONFLICT')
      ),
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    ) STRICT;

    CREATE INDEX revision_proposals_project_idx
      ON revision_proposals(project_id, created_at);

    CREATE TABLE block_lock_decisions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      block_id TEXT NOT NULL,
      block_hash TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('lock', 'unlock')),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX block_lock_decisions_project_idx
      ON block_lock_decisions(project_id, block_id, created_event_seq);

    UPDATE projects SET schema_version = 5;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(5, appliedAt);
    database.exec("PRAGMA user_version = 5;");
  }

  if (fromVersion <= 5) {
    database.exec(`
    CREATE TABLE fact_input_snapshots (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      schema_version TEXT NOT NULL CHECK (schema_version = 'fact-check-v2'),
      policy_version TEXT NOT NULL,
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      body_hash TEXT NOT NULL,
      title_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      title_hash TEXT NOT NULL,
      distribution_copy_hash TEXT,
      evidence_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      evidence_hash TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX fact_input_snapshots_project_idx
      ON fact_input_snapshots(project_id, created_event_seq);

    CREATE TABLE fact_assessments (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL UNIQUE
        REFERENCES fact_input_snapshots(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('passed', 'blocked')),
      payload_json TEXT NOT NULL,
      claims_hash TEXT NOT NULL,
      blockers_json TEXT NOT NULL,
      report_content TEXT NOT NULL,
      report_hash TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    ) STRICT;

    CREATE INDEX fact_assessments_project_idx
      ON fact_assessments(project_id, created_event_seq);

    CREATE TABLE fact_invalidations (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      snapshot_id TEXT NOT NULL REFERENCES fact_input_snapshots(id),
      reason TEXT NOT NULL CHECK (
        reason IN (
          'body_version_changed', 'title_version_changed',
          'evidence_version_changed'
        )
      ),
      changed_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      actor_json TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      created_event_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(snapshot_id, reason, changed_version_id)
    ) STRICT;

    CREATE INDEX fact_invalidations_project_idx
      ON fact_invalidations(project_id, created_event_seq);

    UPDATE projects
       SET fact_gate_status = CASE
             WHEN current_fact_snapshot_id IS NULL AND fact_gate_status = 'not_checked'
               THEN 'not_checked'
             ELSE 'stale'
           END,
           schema_version = 6;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(6, appliedAt);
    database.exec("PRAGMA user_version = 6;");
  }

  if (fromVersion <= 6) {
    database.exec(`
    CREATE TABLE exports (
      id TEXT PRIMARY KEY,
      operation_id TEXT NOT NULL UNIQUE,
      input_hash TEXT NOT NULL,
      expected_project_revision INTEGER NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      mode TEXT NOT NULL CHECK (mode IN ('working_copy', 'publication')),
      format TEXT NOT NULL CHECK (format IN ('markdown', 'txt', 'html')),
      state TEXT NOT NULL CHECK (state IN ('prepared', 'completed')),
      body_version_id TEXT NOT NULL REFERENCES artifact_versions(id),
      body_hash TEXT NOT NULL,
      title_version_id TEXT REFERENCES artifact_versions(id),
      title_hash TEXT,
      distribution_copy_hash TEXT,
      evidence_version_id TEXT REFERENCES artifact_versions(id),
      evidence_hash TEXT,
      fact_snapshot_id TEXT REFERENCES fact_input_snapshots(id),
      assessment_id TEXT REFERENCES fact_assessments(id),
      policy_version TEXT,
      gate_status TEXT NOT NULL CHECK (
        gate_status IN ('not_checked', 'checking', 'passed', 'blocked', 'error', 'stale')
      ),
      relative_path TEXT NOT NULL,
      manifest_relative_path TEXT,
      content_text TEXT NOT NULL,
      manifest_content TEXT,
      content_hash TEXT NOT NULL,
      manifest_hash TEXT,
      byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
      manifest_byte_length INTEGER CHECK (
        manifest_byte_length IS NULL OR manifest_byte_length >= 0
      ),
      actor_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_event_seq INTEGER,
      completed_at TEXT,
      CHECK (
        (mode = 'working_copy' AND format = 'markdown') OR
        (mode = 'publication' AND format IN ('txt', 'html'))
      )
    ) STRICT;

    CREATE INDEX exports_project_idx ON exports(project_id, created_at);
    UPDATE projects SET schema_version = 7;
  `);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(7, appliedAt);
    database.exec("PRAGMA user_version = 7;");
  }

  if (fromVersion <= 7) {
    const projectColumns = database.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>;
    if (!projectColumns.some((column) => column.name === "name_source")) {
      database.exec(`
        ALTER TABLE projects ADD COLUMN name_source TEXT NOT NULL DEFAULT 'legacy'
          CHECK (name_source IN ('placeholder', 'agent', 'manual', 'legacy'));
      `);
    }
    database.exec(`UPDATE projects SET schema_version = ${CURRENT_SCHEMA_VERSION};`);
    database
      .prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(CURRENT_SCHEMA_VERSION, appliedAt);
    database.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};`);
  }
}
