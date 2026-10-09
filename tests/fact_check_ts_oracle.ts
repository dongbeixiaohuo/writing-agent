import { readFileSync } from "node:fs";

import {
  createFactCheckInputSnapshot,
  evaluateFactCheck,
  LEGACY_FACT_CHECK_POLICY_VERSION,
  parseLegacyFactCheckClaimsPayload,
} from "../packages/writing-core/src/index.js";

interface OracleInput {
  readonly snapshotId: string;
  readonly bodyContent: string;
  readonly titleContent: string;
  readonly evidenceContent: string;
  readonly rawClaims: string;
}

const input = JSON.parse(readFileSync(0, "utf8")) as OracleInput;

try {
  const snapshot = createFactCheckInputSnapshot({
    snapshotId: input.snapshotId,
    bodyVersionId: "draft.md",
    bodyContent: input.bodyContent,
    titleVersionId: "04_title.md",
    titleContent: input.titleContent,
    evidenceVersionId: "02_evidence_ledger.json",
    evidenceContent: input.evidenceContent,
  });
  const evaluation = evaluateFactCheck(
    { ...snapshot, policyVersion: LEGACY_FACT_CHECK_POLICY_VERSION },
    {
      bodyContent: input.bodyContent,
      titleContent: input.titleContent,
      evidenceContent: input.evidenceContent,
    },
    parseLegacyFactCheckClaimsPayload(input.rawClaims),
  );
  process.stdout.write(JSON.stringify({
    outcome: evaluation.status,
    blockers: evaluation.blockers,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    outcome: "error",
    blockers: [],
    code: error instanceof Error ? error.message : "UNKNOWN",
  }));
}
