import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../storage/src/index.js";
import { WritingApplicationService } from "../src/index.js";
import { createFactCheckOnlyTools } from "../src/workflow-tools.js";

const actor = { kind: "user", id: "application-fact-test" } as const;

class UnusedProvider extends ModelProviderBase {
  constructor() {
    super("unused", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "unsupported",
      usage: "reported",
    });
  }

  protected async *providerStream(
    _request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    throw new Error("provider must not be called by fact status queries");
  }
}

describe("WritingApplicationService fact-check projection", () => {
  for (const invalidLedger of [false, true]) {
    it(`validates a fact submission before changing title or snapshot (${invalidLedger ? 'invalid evidence' : 'missing empty-claims reason'})`, async () => {
      const workspacePath = mkdtempSync(join(tmpdir(), 'wa-fact-submit-preflight-'));
      const storage = openWorkspaceStorage({ workspacePath });
      try {
        storage.createProject({ operationId: 'create', projectId: 'p', name: 'Preflight', mode: 'quick', actor });
        const body = storage.commitArtifactVersion({ operationId: 'body', projectId: 'p', expectedProjectRevision: 0,
          kind: 'body', logicalKey: 'main', baseVersionId: null, content: '# 感受\n\n我觉得很好。', reason: 'fixture', actor });
        assert.equal(body.ok, true); if (!body.ok) return;
        const evidence = storage.commitArtifactVersion({ operationId: 'evidence', projectId: 'p', expectedProjectRevision: body.projectRevision,
          kind: 'evidence', logicalKey: 'main', baseVersionId: null,
          content: JSON.stringify({ claims: invalidLedger ? [{ evidence_id: 'E001' }] : [], notes: '无外部事实' }), reason: 'fixture', actor });
        assert.equal(evidence.ok, true); if (!evidence.ok) return;
        storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'test' });
        storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', purpose: 'writing-pack:fact-check', planVersion: 'test' });
        const before = storage.inspectProject('p')!;
        const tool = createFactCheckOnlyTools({ storage, projectId: 'p' }).definitions.find(t => t.name === 'submit_fact_check')!;
        const context: any = { projectId: 'p', runId: 'r', operationId: 'invalid', expectedBodyVersionId: body.result.versionId };
        await assert.rejects(async () => tool.execute({ claims: [], noFactualClaimsReason: invalidLedger ? '仅感受' : '' } as never, context),
          { code: invalidLedger ? 'FACT_EVIDENCE_INVALID' : 'FACT_CHECK_EMPTY_REASON_REQUIRED' });
        const after = storage.inspectProject('p')!;
        assert.equal(after.currentTitleVersionId, before.currentTitleVersionId, 'failed submissions cannot invalidate extraction through a new title');
        assert.equal(after.currentFactSnapshotId, before.currentFactSnapshotId);
        assert.equal(after.revision, before.revision);
        assert.equal(storage.listArtifactVersions('p', 'title', 'main').length, 0);
        if (!invalidLedger) {
          await tool.execute({ claims: [], noFactualClaimsReason: '全文只有作者感受，无可核实事实。' } as never, { ...context, operationId: 'corrected' });
          assert.equal(storage.inspectProject('p')!.factGateStatus, 'passed');
        }
      } finally { storage.close(); rmSync(workspacePath, { recursive: true, force: true }); }
    });
  }
  it("exposes the current computed gate and queryable input provenance", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-app-fact-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({
      storage,
      provider: new UnusedProvider(),
    });
    try {
      service.createProject({
        operationId: "create",
        projectId: "project-1",
        name: "Application fact projection",
        mode: "deep",
        actor,
      });
      const body = storage.commitArtifactVersion({
        operationId: "body",
        projectId: "project-1",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 标题\n\n这是作者感受。",
        reason: "fixture",
        actor,
      });
      assert.equal(body.ok, true);
      if (!body.ok) return;
      const title = storage.commitArtifactVersion({
        operationId: "title",
        projectId: "project-1",
        expectedProjectRevision: body.projectRevision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: null,
        content: "- 选择状态：已锁定\n- 最终标题：「标题」\n",
        reason: "fixture",
        actor,
      });
      assert.equal(title.ok, true);
      if (!title.ok) return;
      const evidence = storage.commitArtifactVersion({
        operationId: "evidence",
        projectId: "project-1",
        expectedProjectRevision: title.projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: null,
        content: JSON.stringify({ claims: [], notes: "无外部事实" }),
        reason: "fixture",
        actor,
      });
      assert.equal(evidence.ok, true);
      if (!evidence.ok) return;

      const frozen = service.createFactCheckSnapshot({
        operationId: "freeze",
        projectId: "project-1",
        expectedProjectRevision: evidence.projectRevision,
        bodyVersionId: body.result.versionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      assert.equal(frozen.ok, true);
      if (!frozen.ok) return;
      const evaluated = service.evaluateFactCheckSnapshot({
        operationId: "evaluate",
        projectId: "project-1",
        expectedProjectRevision: frozen.projectRevision,
        snapshotId: frozen.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozen.result.snapshotId,
          bodyVersionId: body.result.versionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "仅有作者感受。",
        },
        actor,
      });
      assert.equal(evaluated.ok, true);

      const projection = service.getProjectProjection("project-1");
      assert.equal(projection.factCheck.status, "passed");
      assert.equal(projection.factCheck.snapshot?.bodyVersionId, body.result.versionId);
      assert.equal(projection.factCheck.assessment?.status, "passed");
      assert.equal(
        projection.provenance.filter(
          (edge) => edge.fromId === frozen.result.snapshotId && edge.relation === "CHECKED_IN",
        ).length,
        3,
      );
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("backs up the current body without a model provider and projects durable exports", () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "wa-app-export-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const service = new WritingApplicationService({ storage });
    try {
      const created = service.createProject({
        operationId: "create-export-project",
        projectId: "project-export",
        name: "Application export projection",
        mode: "quick",
        actor,
      });
      assert.equal(created.ok, true);
      const body = storage.commitArtifactVersion({
        operationId: "export-body",
        projectId: "project-export",
        expectedProjectRevision: 0,
        kind: "body",
        logicalKey: "main",
        baseVersionId: null,
        content: "# 工作稿\n\n尚未核查。",
        reason: "fixture",
        actor,
      });
      assert.equal(body.ok, true);
      if (!body.ok) return;

      const saved = service.saveWorkingCopy({
        operationId: "save-working-copy",
        projectId: "project-export",
        expectedProjectRevision: body.projectRevision,
        bodyVersionId: body.result.versionId,
        actor,
      });
      assert.equal(saved.ok, true);
      if (!saved.ok) return;
      assert.equal(saved.result.mode, "working_copy");

      const formal = service.exportPublication({
        operationId: "reject-formal-export",
        projectId: "project-export",
        expectedProjectRevision: saved.projectRevision,
        bodyVersionId: body.result.versionId,
        factSnapshotId: "missing-fact-snapshot",
        format: "txt",
        actor,
      });
      assert.equal(formal.ok, false);
      if (formal.ok) return;
      assert.equal(formal.code, "FACT_GATE_NOT_PASSED");

      const projection = service.getProjectProjection("project-export");
      assert.equal(projection.exports.length, 1);
      assert.equal(projection.exports[0]?.id, saved.result.id);
    } finally {
      storage.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
