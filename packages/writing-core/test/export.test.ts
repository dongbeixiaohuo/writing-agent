import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as writingCore from "../src/index.js";

const actor = { kind: "user", id: "export-test" } as const;

function requireExportApi() {
  const candidate = writingCore as unknown as Record<string, unknown>;
  for (const name of [
    "prepareWorkingCopyContent",
    "preparePublicationContent",
    "validatePublicationGate",
    "safeExportStem",
  ]) {
    assert.equal(typeof candidate[name], "function", `${name} must be implemented`);
  }
  return candidate as unknown as {
    prepareWorkingCopyContent(input: Record<string, unknown>): {
      mode: "working_copy";
      format: "markdown";
      relativePath: string;
      content: string;
      contentHash: string;
      manifestRelativePath: string;
      manifestContent: string;
      manifestHash: string;
      gateStatus: string;
    };
    preparePublicationContent(input: Record<string, unknown>): {
      mode: "publication";
      format: "txt" | "html";
      relativePath: string;
      content: string;
      contentHash: string;
      manifestRelativePath: null;
      manifestContent: null;
      manifestHash: null;
      gateStatus: "passed";
      title: string;
      assessmentId: string;
    };
    validatePublicationGate(input: Record<string, unknown>): {
      title: string;
      assessmentId: string;
    };
    safeExportStem(input: string): string;
  };
}

function artifact(
  id: string,
  kind: "body" | "title" | "evidence",
  content: string,
) {
  return {
    id,
    artifactId: `artifact:${kind}`,
    projectId: "project-1",
    kind,
    logicalKey: "main",
    content,
    contentHash: writingCore.contentHash(content),
    actor,
    parentVersionIds: [],
    reason: "fixture",
    requestSnapshotId: null,
    createdEventSeq: 1,
    operationId: `create:${id}`,
    createdAt: "2026-09-17T08:00:00.000Z",
  };
}

function fixture(titleText = '安全发布标题', distributionText = '安全摘要') {
  const body = artifact(
    "body-v1",
    "body",
    "# 旧正文标题\n\n正文有 **重点**。\n\n<script onclick=\"steal()\">alert(1)</script>\n\n[x](javascript:alert(1))",
  );
  const title = artifact(
    "title-v1",
    "title",
    `- 选择状态：已锁定\n- 最终标题：${titleText}\n- 平台分发文案：\n- 分发文案选择：A\n- 最终分发文案：${distributionText}\n`,
  );
  const evidence = artifact(
    "evidence-v1",
    "evidence",
    JSON.stringify({ claims: [], notes: "只有作者感受" }),
  );
  const snapshot = writingCore.createFactCheckInputSnapshot({
    snapshotId: "snapshot-v1",
    bodyVersionId: body.id,
    bodyContent: body.content,
    titleVersionId: title.id,
    titleContent: title.content,
    evidenceVersionId: evidence.id,
    evidenceContent: evidence.content,
  });
  const payload = {
    schemaVersion: "fact-check-v2" as const,
    snapshotId: snapshot.snapshotId,
    bodyVersionId: body.id,
    titleVersionId: title.id,
    coverage: { body: true, title: true, distributionCopy: true } as const,
    claims: [],
    noFactualClaimsReason: "全文只有作者感受，没有可核查外部事实。",
  };
  const evaluation = writingCore.evaluateFactCheck(snapshot, {
    bodyContent: body.content,
    titleContent: title.content,
    evidenceContent: evidence.content,
  }, payload);
  const project = {
    id: "project-1",
    name: "CON：客户/文章",
    mode: "deep" as const,
    schemaVersion: 7,
    revision: 8,
    latestBodyVersionId: body.id,
    currentTitleVersionId: title.id,
    currentEvidenceVersionId: evidence.id,
    currentBriefVersionId: null,
    factGateStatus: "passed" as const,
    currentFactSnapshotId: snapshot.snapshotId,
    createdAt: "2026-09-17T08:00:00.000Z",
    updatedAt: "2026-09-17T08:00:00.000Z",
  };
  const assessment = {
    id: "assessment-v1",
    projectId: project.id,
    snapshotId: snapshot.snapshotId,
    payload,
    actor,
    operationId: "assess-v1",
    createdEventSeq: 7,
    createdAt: "2026-09-17T08:10:00.000Z",
    ...evaluation,
  };
  const factCheck = {
    status: "passed" as const,
    currentSnapshotId: snapshot.snapshotId,
    snapshot: {
      ...snapshot,
      projectId: project.id,
      createdEventSeq: 6,
      createdAt: "2026-09-17T08:05:00.000Z",
    },
    assessment,
    invalidations: [],
  };
  return { project, body, title, evidence, factCheck };
}

describe("working-copy and publication export contracts", () => {
  it('preserves colons inside the selected title and hashes the entire selected distribution copy', () => {
    const source = fixture('明天：写下一件小事', '提醒：没有打卡，也没有承诺。');
    const txt = requireExportApi().preparePublicationContent({ ...source, factSnapshotId: source.factCheck.currentSnapshotId, format: 'txt' });
    assert.equal(txt.title, '明天：写下一件小事');
    assert.match(txt.content, /^明天：写下一件小事\n/u);
    assert.equal(source.factCheck.snapshot.distributionCopyHash, writingCore.contentHash('提醒：没有打卡，也没有承诺。'));
  });
  it("always prepares an exact Markdown working copy with an explicit status manifest", () => {
    const api = requireExportApi();
    const source = fixture();
    const prepared = api.prepareWorkingCopyContent({
      project: { ...source.project, factGateStatus: "not_checked", currentFactSnapshotId: null },
      body: source.body,
      factCheck: {
        status: "not_checked",
        currentSnapshotId: null,
        snapshot: null,
        assessment: null,
        invalidations: [],
      },
      operationId: "working-copy-operation",
      createdAt: "2026-09-17T09:00:00.000Z",
    });

    assert.equal(prepared.content, source.body.content);
    assert.equal(prepared.contentHash, source.body.contentHash);
    assert.equal(prepared.gateStatus, "not_checked");
    assert.match(
      prepared.relativePath,
      /\/working\/.*-working-[a-f0-9]{12}-[a-f0-9]{10}\.md$/u,
    );
    assert.equal(prepared.manifestRelativePath, `${prepared.relativePath}.status.json`);
    const manifest = JSON.parse(prepared.manifestContent) as Record<string, unknown>;
    assert.equal(manifest.mode, "working_copy");
    assert.equal(manifest.publicationStatus, "not_checked");
    assert.equal(manifest.warning, "WORKING_COPY_NOT_PUBLICATION");
    assert.equal(manifest.bodyVersionId, source.body.id);
    assert.equal(manifest.operationId, "working-copy-operation");
    assert.equal(
      writingCore.contentHash(prepared.manifestContent),
      prepared.manifestHash,
    );
  });

  it("uses one strict gate for TXT and HTML and renders the locked title safely", () => {
    const api = requireExportApi();
    const source = fixture();
    const input = {
      ...source,
      factSnapshotId: source.factCheck.currentSnapshotId,
    };

    const txt = api.preparePublicationContent({ ...input, format: "txt" });
    const html = api.preparePublicationContent({ ...input, format: "html" });
    const editorialHtml = api.preparePublicationContent({
      ...input,
      format: "html",
      layoutPreset: "editorial",
    });
    const compactHtml = api.preparePublicationContent({
      ...input,
      format: "html",
      layoutPreset: "compact",
    });

    assert.equal(txt.gateStatus, "passed");
    assert.equal(html.gateStatus, "passed");
    assert.equal(txt.assessmentId, "assessment-v1");
    assert.equal(html.assessmentId, "assessment-v1");
    assert.equal(txt.title, "安全发布标题");
    assert.match(txt.content, /^安全发布标题\n/u);
    assert.equal((txt.content.match(/安全发布标题/gu) ?? []).length, 1);
    assert.doesNotMatch(txt.content, /\*\*/u);
    assert.match(txt.relativePath, /\/publication\/.*-[a-f0-9]{12}\.txt$/u);
    assert.match(html.relativePath, /\/publication\/.*-[a-f0-9]{12}\.html$/u);
    assert.match(html.content, /<h1>安全发布标题<\/h1>/u);
    assert.match(html.content, /<strong>重点<\/strong>/u);
    assert.doesNotMatch(html.content, /<script|onclick=|href="javascript:/iu);
    assert.match(html.content, /&lt;script/u);
    assert.match(editorialHtml.relativePath, /-editorial\.html$/u);
    assert.match(compactHtml.relativePath, /-compact\.html$/u);
    assert.match(editorialHtml.content, /Georgia/u);
    assert.match(compactHtml.content, /max-width:880px/u);
    assert.notEqual(editorialHtml.contentHash, html.contentHash);
    assert.notEqual(compactHtml.contentHash, html.contentHash);
    assert.equal(txt.manifestContent, null);
    assert.equal(html.manifestContent, null);
  });

  it("rejects stale, mismatched, or tampered fact results before publication", () => {
    const api = requireExportApi();
    const source = fixture();
    const base = {
      ...source,
      factSnapshotId: source.factCheck.currentSnapshotId,
    };

    assert.throws(
      () => api.validatePublicationGate({
        ...base,
        factCheck: { ...source.factCheck, status: "stale" },
      }),
      /FACT_GATE_NOT_PASSED/u,
    );
    assert.throws(
      () => api.validatePublicationGate({ ...base, factSnapshotId: "old-snapshot" }),
      /FACT_SNAPSHOT_NOT_CURRENT/u,
    );
    assert.throws(
      () => api.validatePublicationGate({
        ...base,
        factCheck: {
          ...source.factCheck,
          assessment: {
            ...source.factCheck.assessment,
            claimsHash: "0".repeat(64),
          },
        },
      }),
      /FACT_CLAIMS_HASH_MISMATCH/u,
    );
    assert.throws(
      () => api.validatePublicationGate({
        ...base,
        factCheck: {
          ...source.factCheck,
          assessment: {
            ...source.factCheck.assessment,
            reportContent: `${source.factCheck.assessment.reportContent}\n篡改`,
          },
        },
      }),
      /FACT_REPORT_HASH_MISMATCH/u,
    );
  });

  it("sanitizes Windows names and path separators without accepting a path", () => {
    const api = requireExportApi();
    assert.equal(api.safeExportStem("  CON  "), "_CON");
    assert.equal(api.safeExportStem("客户/文章:*?"), "客户_文章");
    assert.equal(api.safeExportStem("..."), "untitled");
  });
});
