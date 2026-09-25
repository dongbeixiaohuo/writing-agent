// Synthetic SQLite/provider fixture. It exercises the real ApplicationBridge,
// Local Web Host and production renderer without user projects or credentials.
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

import { WritingApplicationService } from '../../packages/application/src/index.js';
import { createApplicationBridge } from '../../packages/client-bridge/src/application-bridge.js';
import { startLocalWebHost } from '../../packages/client-bridge/src/local-web-host.js';
import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from '../../packages/runtime/llm/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';

class CountingProvider extends ModelProviderBase {
  calls = 0;

  constructor() {
    super('legacy-parity-synthetic-provider', '1.0.0', {
      protocol: 'mock',
      streaming: 'supported',
      tools: 'supported',
      usage: 'unknown',
    });
  }

  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    this.calls += 1;
    const toolMessages = request.messages.filter(message => message.role === 'tool');
    const reads = toolMessages.filter(message => message.name === 'read_artifact_version');
    let task: { bodyVersionId?: string; evidenceVersionId?: string } = {};
    for (const message of request.messages) {
      if (message.role !== 'user') continue;
      try {
        const candidate = JSON.parse(message.content) as typeof task & { task?: string };
        if (candidate.task === 'recheck_current_article') task = candidate;
      } catch {
        // Conversation history may contain ordinary prose; only the JSON task matters.
      }
    }
    if (typeof task.bodyVersionId !== 'string' || typeof task.evidenceVersionId !== 'string') {
      throw new Error('SYNTHETIC_FACT_TASK_MISSING_INPUTS');
    }
    if (reads.length < 2) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: `fact-read-${reads.length}-${request.requestId}`,
        name: 'read_artifact_version',
        argumentsDelta: JSON.stringify({
          versionId: reads.length === 0 ? task.bodyVersionId : task.evidenceVersionId,
        }),
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    if (!toolMessages.some(message => message.name === 'submit_fact_check')) {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: `fact-submit-${request.requestId}`,
        name: 'submit_fact_check',
        argumentsDelta: JSON.stringify({
          claims: [],
          noFactualClaimsReason: '合成正文不含需要外部核实的事实主张。',
        }),
      };
      yield { type: 'completed', finishReason: 'tool_calls' };
      return;
    }
    yield { type: 'text_delta', delta: '当前版本核查结果已保存。' };
    yield { type: 'completed', finishReason: 'stop' };
  }
}

const fixtureParent = resolve('output/legacy-parity-browser-workspaces');
mkdirSync(fixtureParent, { recursive: true });
const fixtureRoot = mkdtempSync(join(fixtureParent, 'run-'));
const workspacePath = join(fixtureRoot, 'workspace');
const staticRoot = resolve('apps/web/dist/production');
if (!existsSync(join(staticRoot, 'index.html'))) throw new Error('PRODUCTION_RENDERER_MISSING');
const storage = openWorkspaceStorage({ workspacePath });
const actor = { kind: 'user' as const, id: 'browser-fixture-user' };

function ok<T extends { ok: boolean }>(result: T): asserts result is T & { ok: true } {
  if (!result.ok) throw new Error(`FIXTURE_SEED_FAILED:${JSON.stringify(result)}`);
}

ok(storage.createProject({
  operationId: 'fixture-project',
  projectId: 'legacy-parity',
  name: '主对话改稿验收',
  mode: 'quick',
  actor,
}));
storage.createSession({
  projectId: 'legacy-parity',
  sessionId: 'legacy-parity-session',
  purpose: 'writing-pack:author-conversation',
});
ok(storage.saveWritingBrief({
  operationId: 'fixture-brief',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  baseVersionId: null,
  actor,
  brief: {
    schemaVersion: 1,
    topic: '安静的观察',
    genre: 'narrative_observation',
    audience: '普通读者',
    lengthTarget: { targetCharacters: 800 },
    materialIds: [],
    constraints: ['不编造经历'],
    interactionMode: 'autonomous',
    authorAuthorization: {
      voice: null,
      styleReference: null,
      styleDecision: 'unspecified',
      directionDecision: 'user_confirmed',
      firsthandMaterialIds: [],
    },
    platform: null,
    publicationGoal: 'not_applicable',
    confirmationStatus: 'confirmed',
  },
}));
const originalBody = '# 安静的观察\n\n第一段必须保留。\n\n第二段原来有点拖沓，需要压缩。\n\n第三段也必须保留。';
const body = storage.commitArtifactVersion({
  operationId: 'fixture-body',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  kind: 'body',
  logicalKey: 'main',
  baseVersionId: null,
  content: originalBody,
  reason: 'Synthetic browser fixture body',
  actor,
});
ok(body);
const title = storage.commitArtifactVersion({
  operationId: 'fixture-title',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  kind: 'title',
  logicalKey: 'main',
  baseVersionId: null,
  content: '- 选择状态：已锁定\n- 最终标题：「安静的观察」\n',
  reason: 'Synthetic locked title',
  actor,
});
ok(title);
const evidence = storage.commitArtifactVersion({
  operationId: 'fixture-evidence',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  kind: 'evidence',
  logicalKey: 'main',
  baseVersionId: null,
  content: JSON.stringify({ claims: [], notes: '合成正文不含外部事实主张。' }),
  reason: 'Synthetic evidence ledger',
  actor,
});
ok(evidence);
const factSnapshot = storage.createFactCheckSnapshot({
  operationId: 'fixture-fact-snapshot',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  bodyVersionId: body.result.versionId,
  titleVersionId: title.result.versionId,
  evidenceVersionId: evidence.result.versionId,
  actor,
});
ok(factSnapshot);
ok(storage.evaluateFactCheckSnapshot({
  operationId: 'fixture-fact-result',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  snapshotId: factSnapshot.result.snapshotId,
  actor,
  payload: {
    schemaVersion: 'fact-check-v2',
    snapshotId: factSnapshot.result.snapshotId,
    bodyVersionId: body.result.versionId,
    titleVersionId: title.result.versionId,
    coverage: { body: true, title: true, distributionCopy: true },
    claims: [],
    noFactualClaimsReason: '合成正文不含外部事实主张。',
  },
}));
const document = storage.getBodyDocument(body.result.versionId)!;
const target = document.blocks.find(block => block.content === '第二段原来有点拖沓，需要压缩。');
if (target === undefined) throw new Error('FIXTURE_TARGET_BLOCK_MISSING');
ok(storage.proposeRevision({
  operationId: 'fixture-proposal',
  projectId: 'legacy-parity',
  expectedProjectRevision: storage.inspectProject('legacy-parity')!.revision,
  proposalId: 'proposal-browser-parity',
  baseBodyVersionId: body.result.versionId,
  instruction: '只压缩第二段，其他段落保持不变',
  constraints: ['保留第一段', '保留第三段'],
  edits: [{
    type: 'replace',
    targetBlockId: target.id,
    baseBlockHash: target.contentHash,
    content: '第二段已经压缩。',
  }],
  actor: { kind: 'agent', id: 'synthetic-reviser', runId: 'fixture-run' },
}));

const provider = new CountingProvider();
const service = new WritingApplicationService({ storage, provider });
const bridge = createApplicationBridge({
  service,
  workspaceId: 'legacy-parity-browser',
  initialProjectId: 'legacy-parity',
  pollIntervalMs: 50,
  model: {
    model: 'synthetic-no-api',
    providerLabel: '合成浏览器验收',
    credentialReference: 'TEST_ONLY',
    parameters: {},
  },
});
await bridge.selectSession('legacy-parity', 'legacy-parity-session');
const host = await startLocalWebHost({ staticRoot, bridgeFactory: () => bridge });

function state() {
  const project = storage.inspectProject('legacy-parity')!;
  const currentBody = project.latestBodyVersionId === null
    ? null
    : storage.getArtifactVersion(project.latestBodyVersionId);
  return {
    body: currentBody?.content ?? null,
    bodyVersionId: currentBody?.id ?? null,
    factGateStatus: project.factGateStatus,
    pendingProposals: storage.listRevisionProposals('legacy-parity')
      .filter(proposal => proposal.status === 'proposed').length,
    exports: storage.listExports('legacy-parity').map(record => ({
      mode: record.mode,
      state: record.state,
      relativePath: record.relativePath,
      bodyVersionId: record.bodyVersionId,
    })),
    providerCalls: provider.calls,
  };
}

process.stdout.write(`${JSON.stringify({ origin: host.origin, fixtureRoot, workspacePath })}\n`);
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line) as { method?: string };
  if (request.method === 'stop') break;
  process.stdout.write(`${JSON.stringify(request.method === 'state'
    ? { ok: true, state: state() }
    : { ok: false, error: 'UNKNOWN_FIXTURE_METHOD' })}\n`);
}

await host.close();
bridge.dispose();
storage.close();
// Preserve this exact synthetic workspace for evidence and later inspection.
// Never infer ownership of another process's directory from a shared prefix.
