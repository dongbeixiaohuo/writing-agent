import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openWorkspaceStorage } from "../../storage/src/index.js";
import type { SecureWebFetchResult } from "../../runtime/tools/src/index.js";
import { createFactSourceTool, type FactSourceFetcher } from "../src/fact-web.js";

test('source transport failure is classified without leaking URL credentials or provider text', async () => {
  const f = setup(LEDGER_URL);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: {
      fetchText: async () => { throw new Error('socket failed secret-private-provider-diagnostics'); },
    } });
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'r' } as never), (error: any) => {
      assert.equal(error.code, 'FACT_SOURCE_FETCH_UNAVAILABLE');
      assert.match(error.message, /摘录/);
      assert.doesNotMatch(error.message, /secret-private/);
      return true;
    });
  } finally { f.close(); }
});

const actor = { kind: "user", id: "fact-web-test" } as const;
const LEDGER_URL = "https://93.184.216.34/report-2026";

function setup(ledgerContent: string) {
  const directory = mkdtempSync(join(tmpdir(), "wa-fact-web-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  storage.createProject({ projectId: "p", operationId: "p", name: "probe", mode: "quick", actor });
  storage.commitArtifactVersion({
    operationId: "ev", projectId: "p", expectedProjectRevision: storage.inspectProject("p")!.revision,
    kind: "evidence", logicalKey: "main", baseVersionId: null, content: ledgerContent,
    reason: "probe", actor: { kind: "agent", id: "research", runId: "r" },
  });
  return { storage, close() { storage.close(); rmSync(directory, { recursive: true, force: true }); } };
}

function fetcherWith(text: string, captured: string[]): FactSourceFetcher {
  return {
    fetchText: async (url: string) => {
      captured.push(url);
      return {
        finalUrl: url,
        redirectCount: 0,
        contentType: "text/html",
        bodyHash: "body-hash",
        content: {
          text,
          trustLabel: "external_untrusted",
          instructionAuthority: "none",
          activeContentRemoved: true,
          truncated: false,
          totalChars: text.length,
        },
      } satisfies SecureWebFetchResult;
    },
  };
}

test("fact source tool re-reads only URLs recorded in the evidence ledger and returns inert text", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"${LEDGER_URL}"}]}`);
  try {
    const captured: string[] = [];
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("来源原文：某地实际增长为 3%。", captured) });
    const result = await tool.execute({ url: LEDGER_URL }, { projectId: "p", runId: "r", operationId: "op" } as never);
    assert.equal(captured.length, 1);
    assert.equal(captured[0], LEDGER_URL);
    const view = result as { text: string; trustLabel: string; instructionAuthority: string; truncated: boolean };
    assert.match(view.text, /增长为 3%/u);
    assert.equal(view.trustLabel, "external_untrusted");
    assert.equal(view.instructionAuthority, "none");
    assert.equal(view.truncated, false);
  } finally { f.close(); }
});

test('fact source tool permits discovered URLs only in the searching run and respects disabled search', async () => {
  const f = setup('{"claims":[]}');
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: 'p', fetcher: fetcherWith('网页原文', []),
      isDiscoveredSource: (url, runId) => url === LEDGER_URL && runId === 'searched' });
    await tool.execute({ url: LEDGER_URL }, { runId: 'searched' } as never);
    await assert.rejects(async () => tool.execute({ url: LEDGER_URL }, { runId: 'other' } as never));
    const off = createFactSourceTool({ storage: f.storage, projectId: 'p', searchEnabled: () => false,
      isDiscoveredSource: () => true, fetcher: fetcherWith('must not fetch', []) });
    await assert.rejects(async () => off.execute({ url: LEDGER_URL }, { runId: 'searched' } as never), /disabled/);
  } finally { f.close(); }
});

test("fact source tool refuses URLs that are not in the ledger instead of browsing", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"${LEDGER_URL}"}]}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: "https://other.example.test/anything" }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "FACT_SOURCE_NOT_IN_LEDGER");
        assert.match(String((error as Error).message), /NEEDS_USER_SOURCE/u);
        return true;
      },
    );
  } finally { f.close(); }
});

test("fact source tool still enforces the network policy on ledger URLs", async () => {
  const f = setup(`{"claims":[{"evidence_id":"E001","source_url":"https://127.0.0.1/internal"}]}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: "https://127.0.0.1/internal" }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok("code" in (error as object), "policy errors carry a code");
        return true;
      },
    );
  } finally { f.close(); }
});

test("fact source tool reports an empty ledger without fetching", async () => {
  const f = setup(`{"claims":[],"notes":"纯个人感受"}`);
  try {
    const tool = createFactSourceTool({ storage: f.storage, projectId: "p", fetcher: fetcherWith("不应被读取", []) });
    await assert.rejects(
      async () => tool.execute({ url: LEDGER_URL }, { projectId: "p", runId: "r", operationId: "op" } as never),
      (error: unknown) => (error as { code?: string }).code === "FACT_SOURCE_NOT_IN_LEDGER",
    );
  } finally { f.close(); }
});
