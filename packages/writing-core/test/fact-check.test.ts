import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import * as core from "../src/index.js";

type FactApi = {
  createFactCheckInputSnapshot(input: Record<string, unknown>): Record<string, unknown>;
  evaluateFactCheck(
    snapshot: Record<string, unknown>,
    contents: Record<string, string>,
    payload: Record<string, unknown>,
  ): {
    status: "passed" | "blocked";
    blockers: readonly string[];
    reportContent: string;
  };
  parseLegacyFactCheckClaimsPayload(input: string): Record<string, unknown>;
};

function factApi(): FactApi {
  const candidate = core as unknown as Partial<FactApi>;
  assert.equal(
    typeof candidate.createFactCheckInputSnapshot,
    "function",
    "createFactCheckInputSnapshot must be implemented",
  );
  assert.equal(
    typeof candidate.evaluateFactCheck,
    "function",
    "evaluateFactCheck must be implemented",
  );
  assert.equal(
    typeof candidate.parseLegacyFactCheckClaimsPayload,
    "function",
    "parseLegacyFactCheckClaimsPayload must be implemented",
  );
  return candidate as FactApi;
}

const bodyContent = "# 夹具标题\n\n这是作者的合成感受。";
const titleContent = "- 选择状态：已锁定\n- 最终标题：「夹具标题」\n";
const evidenceContent = JSON.stringify({
  claims: [],
  notes: "全文没有外部事实",
});

describe("fact-check-v2 domain policy", () => {
  it("passes an explicitly covered no-facts assessment bound to frozen inputs", () => {
    const api = factApi();
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-1",
      bodyVersionId: "body-v1",
      bodyContent,
      titleVersionId: "title-v1",
      titleContent,
      evidenceVersionId: "evidence-v1",
      evidenceContent,
    });
    const result = api.evaluateFactCheck(
      snapshot,
      { bodyContent, titleContent, evidenceContent },
      {
        schemaVersion: "fact-check-v2",
        snapshotId: "snapshot-1",
        bodyVersionId: "body-v1",
        titleVersionId: "title-v1",
        coverage: { body: true, title: true, distributionCopy: true },
        claims: [],
        noFactualClaimsReason: "全文为作者感受，没有可核查的外部事实。",
      },
    );

    assert.equal(result.status, "passed");
    assert.deepEqual(result.blockers, []);
    assert.match(result.reportContent, /核查状态：passed/u);
  });

  it("blocks every legacy non-supported, red, or non-full claim outcome", () => {
    const api = factApi();
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-blockers",
      bodyVersionId: "body-v1",
      bodyContent,
      titleVersionId: "title-v1",
      titleContent,
      evidenceVersionId: "evidence-v1",
      evidenceContent,
    });
    snapshot.policyVersion = 'fact-check-v2-ts-v1'; // Explicit historical strict policy.
    const scenarios = [
      { status: "CONTRADICTED", risk: "yellow", supportScope: "none" },
      { status: "UNSUPPORTED", risk: "yellow", supportScope: "none" },
      { status: "BROKEN_LINK", risk: "yellow", supportScope: "none" },
      { status: "NEEDS_USER_SOURCE", risk: "yellow", supportScope: "none" },
      { status: "SUPPORTED", risk: "green", supportScope: "partial" },
      { status: "SUPPORTED", risk: "green", supportScope: "none" },
      { status: "SUPPORTED", risk: "red", supportScope: "full" },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const claimId = `C${String(index + 1).padStart(3, "0")}`;
      const result = api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent, evidenceContent },
        {
          status: "passed",
          schemaVersion: "fact-check-v2",
          snapshotId: "snapshot-blockers",
          bodyVersionId: "body-v1",
          titleVersionId: "title-v1",
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [{
            claimId,
            claimText: "一项待核查的说法",
            claimType: "number",
            location: "正文第 1 段",
            ...scenario,
            matchedEvidenceId: null,
            sourceReference: "用户提供材料第 2 页",
            evidenceSummary: "核查说明",
            recommendedAction: "删除或补充来源",
          }],
          noFactualClaimsReason: "",
        },
      );
      assert.equal(result.status, "blocked", JSON.stringify(scenario));
      assert.deepEqual(result.blockers, [claimId]);
      assert.match(result.reportContent, /核查状态：blocked/u);
    }
  });

  it("legacy policy requires every supported claim to name a persisted evidence item or source", () => {
    const api = factApi();
    const evidenceWithClaim = JSON.stringify({
      claims: [{
        evidence_id: "E001",
        claim_type: "number",
        claim_text: "合成比例",
        source_title: "合成材料",
        source_publisher: "测试发布者",
        source_quote: "用于测试的摘录",
        accessed_at: "2026-09-17T00:00:00+08:00",
        reliability: "high",
        use_boundary: "只支持该比例",
        verification_status: "verified",
      }],
    });
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-sources",
      bodyVersionId: "body-v1",
      bodyContent,
      titleVersionId: "title-v1",
      titleContent,
      evidenceVersionId: "evidence-v1",
      evidenceContent: evidenceWithClaim,
    });
    snapshot.policyVersion = core.LEGACY_FACT_CHECK_POLICY_VERSION;
    const payload = {
      schemaVersion: "fact-check-v2",
      snapshotId: "snapshot-sources",
      bodyVersionId: "body-v1",
      titleVersionId: "title-v1",
      coverage: { body: true, title: true, distributionCopy: true },
      claims: [{
        claimId: "C001",
        claimText: "一项被支持的说法",
        claimType: "number",
        location: "正文第 1 段",
        status: "SUPPORTED",
        risk: "green",
        supportScope: "full",
        matchedEvidenceId: null,
        sourceReference: null,
        evidenceSummary: "核查说明",
        recommendedAction: "保留",
      }],
      noFactualClaimsReason: "",
    };

    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent, evidenceContent: evidenceWithClaim },
        payload,
      ),
      /FACT_CHECK_SOURCE_REQUIRED/u,
    );
    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent, evidenceContent: evidenceWithClaim },
        {
          ...payload,
          claims: [{ ...payload.claims[0], matchedEvidenceId: "E999" }],
        },
      ),
      /FACT_CHECK_EVIDENCE_REFERENCE_INVALID/u,
    );
    const passed = api.evaluateFactCheck(
      snapshot,
      { bodyContent, titleContent, evidenceContent: evidenceWithClaim },
      {
        ...payload,
        claims: [{ ...payload.claims[0], matchedEvidenceId: "E001" }],
      },
    );
    assert.equal(passed.status, "passed");
  });

  it("accepts illustrative ledger entries with empty source quotes but rejects empty quotes otherwise", () => {
    const api = factApi();
    const ledger = (quote: string, status: string) => JSON.stringify({
      claims: [{
        evidence_id: "E001",
        claim_type: "other",
        claim_text: "概念间的通行区分",
        source_title: "条件式推演（无外部来源核实）",
        source_publisher: "推演",
        source_quote: quote,
        accessed_at: "本次运行",
        reliability: "low",
        use_boundary: "只作条件式论证，不得写成权威定义",
        verification_status: status,
      }],
      notes: "含推演条目",
    });
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-illustrative",
      bodyVersionId: "body-v1",
      bodyContent,
      titleVersionId: "title-v1",
      titleContent,
      evidenceVersionId: "evidence-v1",
      evidenceContent: ledger("", "illustrative"),
    });
    const passed = api.evaluateFactCheck(
      snapshot,
      { bodyContent, titleContent, evidenceContent: ledger("", "illustrative") },
      {
        schemaVersion: "fact-check-v2",
        snapshotId: "snapshot-illustrative",
        bodyVersionId: "body-v1",
        titleVersionId: "title-v1",
        coverage: { body: true, title: true, distributionCopy: true },
        claims: [{
          claimId: "C001",
          claimText: "一项被支持的说法",
          claimType: "other",
          location: "正文第 1 段",
          status: "SUPPORTED",
          risk: "green",
          supportScope: "full",
          matchedEvidenceId: "E001",
          sourceReference: null,
          evidenceSummary: "推演条目支持条件式表述",
          recommendedAction: "保留",
        }],
        noFactualClaimsReason: "",
      },
    );
    assert.equal(passed.status, "passed");
    assert.throws(
      () => api.createFactCheckInputSnapshot({
        snapshotId: "snapshot-empty-quote",
        bodyVersionId: "body-v1",
        bodyContent,
        titleVersionId: "title-v1",
        titleContent,
        evidenceVersionId: "evidence-v1",
        evidenceContent: ledger("", "user_provided"),
      }),
      /FACT_EVIDENCE_INVALID/u,
    );
  });

  it("locks declared distribution copy and rejects stale or wrongly bound inputs", () => {
    const api = factApi();
    const titleWithDistribution = [
      "- 选择状态：已锁定",
      "- 最终标题：「夹具标题」",
      "- 平台分发文案：",
      "- 分发文案选择：A",
      "- 最终分发文案：这是最终分发文案",
      "",
    ].join("\n");
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-binding",
      bodyVersionId: "body-v1",
      bodyContent,
      titleVersionId: "title-v1",
      titleContent: titleWithDistribution,
      evidenceVersionId: "evidence-v1",
      evidenceContent,
    });
    assert.equal(typeof snapshot.distributionCopyHash, "string");

    const payload = {
      schemaVersion: "fact-check-v2",
      snapshotId: "snapshot-binding",
      bodyVersionId: "body-v1",
      titleVersionId: "title-v1",
      coverage: { body: true, title: true, distributionCopy: true },
      claims: [],
      noFactualClaimsReason: "没有可核查事实。",
    };
    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent: `${bodyContent}\n变化`, titleContent: titleWithDistribution, evidenceContent },
        payload,
      ),
      /FACT_CHECK_STALE/u,
    );
    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent: titleWithDistribution, evidenceContent },
        { ...payload, snapshotId: "old-snapshot" },
      ),
      /FACT_CHECK_BINDING_INVALID/u,
    );
    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent: titleWithDistribution, evidenceContent },
        { ...payload, coverage: { ...payload.coverage, title: false } },
      ),
      /FACT_CHECK_COVERAGE_INCOMPLETE/u,
    );
    assert.throws(
      () => api.evaluateFactCheck(
        snapshot,
        { bodyContent, titleContent: titleWithDistribution, evidenceContent },
        { ...payload, noFactualClaimsReason: "" },
      ),
      /FACT_CHECK_EMPTY_REASON_REQUIRED/u,
    );
    assert.throws(
      () => api.createFactCheckInputSnapshot({
        snapshotId: "snapshot-provisional",
        bodyVersionId: "body-v1",
        bodyContent,
        titleVersionId: "title-v1",
        titleContent: "- 选择状态：暂定\n- 最终标题：[待定]\n",
        evidenceVersionId: "evidence-v1",
        evidenceContent,
      }),
      /FACT_TITLE_NOT_LOCKED/u,
    );
    assert.throws(
      () => api.createFactCheckInputSnapshot({
        snapshotId: "snapshot-distribution",
        bodyVersionId: "body-v1",
        bodyContent,
        titleVersionId: "title-v1",
        titleContent: "- 选择状态：已锁定\n- 最终标题：「夹具标题」\n- 平台分发文案：待定\n",
        evidenceVersionId: "evidence-v1",
        evidenceContent,
      }),
      /FACT_DISTRIBUTION_NOT_LOCKED/u,
    );
  });

  it("evaluates the canonical legacy fixtures with the same pass/block/error outcomes", () => {
    const api = factApi();
    const fixtureRoot = resolve("tests/fixtures/legacy/fact-gate-v2");
    const fixtureBody = readFileSync(resolve(fixtureRoot, "base/draft.md"), "utf8");
    const fixtureTitle = readFileSync(resolve(fixtureRoot, "base/04_title.md"), "utf8");
    const fixtureEvidence = readFileSync(
      resolve(fixtureRoot, "base/02_evidence_ledger.json"),
      "utf8",
    );
    const snapshot = api.createFactCheckInputSnapshot({
      snapshotId: "snapshot-fixture",
      bodyVersionId: "draft.md",
      bodyContent: fixtureBody,
      titleVersionId: "04_title.md",
      titleContent: fixtureTitle,
      evidenceVersionId: "02_evidence_ledger.json",
      evidenceContent: fixtureEvidence,
    });
    const cases = JSON.parse(
      readFileSync(resolve(fixtureRoot, "cases.json"), "utf8"),
    ) as Array<{ id: string; input: string; expected: "passed" | "blocked" | "error" }>;

    for (const fixture of cases) {
      const raw = readFileSync(resolve(fixtureRoot, fixture.input), "utf8")
        .replaceAll("__SNAPSHOT_ID__", "snapshot-fixture");
      if (fixture.expected === "error") {
        assert.throws(
          () => api.evaluateFactCheck(
            snapshot,
            {
              bodyContent: fixtureBody,
              titleContent: fixtureTitle,
              evidenceContent: fixtureEvidence,
            },
            api.parseLegacyFactCheckClaimsPayload(raw),
          ),
          Error,
          fixture.id,
        );
        continue;
      }
      const result = api.evaluateFactCheck(
        { ...snapshot, policyVersion: core.LEGACY_FACT_CHECK_POLICY_VERSION },
        {
          bodyContent: fixtureBody,
          titleContent: fixtureTitle,
          evidenceContent: fixtureEvidence,
        },
        api.parseLegacyFactCheckClaimsPayload(raw),
      );
      assert.equal(result.status, fixture.expected, fixture.id);
    }
  });
});
