/** Replays a confirmed-title fact-check on a COPY of an incident database only. */
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDesktopProviderProfile } from '../../apps/desktop/src/provider-profile.js';
import { createConfiguredProvider, createDefaultCredentialBroker } from '../../packages/runtime/provider-config/src/index.js';
import { ModelProviderBase, type ModelRequest, type ProviderStreamEvent } from '../../packages/runtime/llm/src/index.js';
import { WritingApplicationService } from '../../packages/application/src/index.js';
import { openWorkspaceStorage } from '../../packages/storage/src/index.js';
import { isPublicationSelectionCurrent } from '../../packages/application/src/publication-choice.js';

const source = process.argv[2]!;
assert.ok(source && resolve(source).startsWith(resolve(tmpdir())), 'Read an isolated audit backup, never live workspace');
const root = mkdtempSync(join(tmpdir(), 'wa-rc36-real-'));
mkdirSync(join(root, '.writing-agent'));
copyFileSync(source, join(root, '.writing-agent/workspace.sqlite3'));
const profile = loadDesktopProviderProfile(join(process.env.APPDATA!, 'Writing Agent/provider.json'))!;
assert.equal(profile.model, 'MiniMax-M3');
const real = createConfiguredProvider(profile, createDefaultCredentialBroker());
const requests: any[] = [];
class ObservedProvider extends ModelProviderBase {
  constructor() { super(real.id, real.adapterVersion, real.capabilities); }
  override capabilitiesFor(model: string) { return real.capabilitiesFor(model); }
  protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
    assert.ok(requests.length < 20, 'Isolated validation request cap');
    const started = Date.now();
    const sample: any = { tools: request.tools.map(t => t.name), firstContentMs: null, contentEvents: 0 };
    requests.push(sample);
    console.log(JSON.stringify({ request: requests.length, tools: sample.tools }));
    try {
      for await (const event of real.stream(request)) {
        if (event.type === 'text_delta' || event.type === 'tool_call_delta') {
          sample.firstContentMs ??= Date.now() - started; sample.contentEvents++;
        }
        if (event.type === 'usage') sample.usage = event.usage;
        yield event;
      }
    } finally { sample.totalMs = Date.now() - started; }
  }
}
const storage = openWorkspaceStorage({ workspacePath: root });
const app = new WritingApplicationService({ storage, provider: new ObservedProvider() });
const projectId = 'project:61ef4f69-1f3f-4dee-98a0-1f10fbd8a2c7';
const sessionId = 'e09263d2-aed3-4d20-9c3c-ae57082f523b';
const report: any = { status: 'FAIL', root, requests, originalProjectWrites: 0 };
try {
  const before = storage.inspectProject(projectId)!;
  assert.ok(isPublicationSelectionCurrent(storage, projectId), 'Existing user title remains selected after body correction');
  const titles = storage.listArtifactVersions(projectId, 'title', 'main').length;
  const handoff = await app.startAuthorTurn({ projectId, sessionId, model: profile.model, parameters: { temperature: 0 }, userInstruction: '标题已确认，请继续核查当前稿件' }).result;
  assert.ok(handoff.ok, JSON.stringify(handoff));
  assert.ok(requests.length <= 2, 'Formal check handoff must not loop through incapable expert');
  assert.ok(storage.listRunEvents(handoff.runId).some(e => e.type === 'tool.completed' && (e.payload.result as any)?.result?.requestedAction === 'fact_check'));
  const check = await app.runFactCheck({ projectId, sessionId, expectedProjectRevision: storage.inspectProject(projectId)!.revision,
    model: profile.model, parameters: { temperature: 0 }, budget: { maxModelRequests: 16, maxToolCalls: 24, maxRetriesPerRequest: 0, maxMajorRevisions: 0 } });
  report.check = check;
  assert.ok(check.ok, JSON.stringify(check));
  assert.equal(storage.inspectProject(projectId)!.latestBodyVersionId, before.latestBodyVersionId);
  assert.equal(storage.listArtifactVersions(projectId, 'title', 'main').length, titles);
  report.factStatus = storage.getFactCheckStatus(projectId);
  // This incident still contains model-invented first-person scene details.
  // A successful request is not enough: it must not erase that real fact risk.
  assert.equal(report.factStatus.status, 'blocked');
  assert.ok(report.factStatus.assessment.payload.claims.some((claim:any) => /倒|水|小时候|礼盒|群里/.test(claim.claimText) && claim.status !== 'SUPPORTED'));
  report.status = 'PASS';
} finally {
  storage.close(); mkdirSync('output/rc36', { recursive: true });
  writeFileSync('output/rc36/real-fact-recovery.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ status: report.status, requests: requests.length, root }));
}
