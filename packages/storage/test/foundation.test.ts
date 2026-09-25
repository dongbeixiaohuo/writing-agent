import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../src/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/schema.js";

describe("workspace storage foundation", () => {
  it("creates a project atomically and reads it back after restart", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-wa005-"));
    const options = {
      workspacePath,
      clock: () => "2026-09-16T08:00:00.000Z",
      idFactory: (() => {
        let next = 0;
        return () => `generated-${++next}`;
      })(),
    };

    let storage = openWorkspaceStorage(options);
    try {
      const created = storage.createProject({
        operationId: "operation-create-project-1",
        projectId: "project-1",
        name: "第一篇文章",
        mode: "deep",
        actor: { kind: "user", id: "user-1" },
      });

      assert.equal(created.ok, true);
      if (!created.ok) return;
      assert.deepEqual(created.result, {
        projectId: "project-1",
        revision: 0,
      });

      const project = storage.inspectProject("project-1");
      assert.deepEqual(project, {
        id: "project-1",
        name: "第一篇文章",
        mode: "deep",
        schemaVersion: CURRENT_SCHEMA_VERSION,
        revision: 0,
        latestBodyVersionId: null,
        currentTitleVersionId: null,
        currentEvidenceVersionId: null,
        currentBriefVersionId: null,
        factGateStatus: "not_checked",
        currentFactSnapshotId: null,
        createdAt: "2026-09-16T08:00:00.000Z",
        updatedAt: "2026-09-16T08:00:00.000Z",
      });

      const events = storage.listEvents("project-1", 0);
      assert.equal(events.length, 1);
      assert.equal(events[0]?.projectSeq, 1);
      assert.equal(events[0]?.type, "project.created");
      assert.deepEqual(events[0]?.payload, {
        name: "第一篇文章",
        mode: "deep",
      });
    } finally {
      storage.close();
    }

    storage = openWorkspaceStorage(options);
    try {
      assert.equal(storage.inspectProject("project-1")?.name, "第一篇文章");
      assert.equal(storage.listEvents("project-1", 0).length, 1);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
