import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CredentialBroker,
  type SystemCredentialBackend,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../../packages/runtime/llm/src/index.js";
import { DesktopApplicationHost } from "../src/application-host.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import { DesktopClientBridge } from '../../../packages/client-bridge/src/desktop-bridge.js';
import { dispatchDesktopRpc } from '../src/rpc-host.js';

test('desktop URL reader survives provider replacement and imports a first-turn article without a brief', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-desktop-web-'));
  const url = 'https://93.184.216.34/article';
  const article = '公众号文章正文，作为第三方参考素材保存。';
  let fetches = 0;
  class ReaderProvider extends ModelProviderBase {
    constructor(id: string) { super(id, 'test', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      const result = request.messages.find(message => message.role === 'tool');
      if (result) assert.ok(result.content.includes(article), 'desktop must inject its reader into every new service');
      yield { type: 'tool_call_delta', index: 0, id: request.requestId,
        name: result ? 'respond_writing_intake' : 'read_author_web',
        argumentsDelta: JSON.stringify(result
          ? { reply: '已读取正文，先聊聊你的想法。', summary: '已读取参考文章', questions: [] }
          : { url }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {} }), providerFactory: config => new ReaderProvider(config.providerId),
    authorWebFetcher: { async fetchText() {
      fetches++;
      return { finalUrl: url, redirectCount: 0, contentType: 'text/html', bodyHash: 'test', content: {
        text: article, totalChars: article.length, truncated: false, activeContentRemoved: true,
        trustLabel: 'external_untrusted', instructionAuthority: 'none' } };
    } } });
  try {
    const config = await host.configureProvider({ kind: 'openai_compatible', providerId: 'reader-provider', baseURL: 'https://example.test/v1',
      model: 'first', models: ['first', 'second'], tools: 'supported', usage: 'unknown', apiKey: 'test', persistence: 'session' });
    await host.selectProvider(config.activeProfileId!, 'second');
    await host.bridge.startConversation(`参考这篇公众号文章：${url}`);
    const deadline = Date.now() + 20_000;
    while (host.bridge.getSnapshot().connection !== 'ready') {
      if (Date.now() > deadline) throw new Error('intake did not finish');
      await new Promise(resolve => setTimeout(resolve, 10));
      await host.bridge.refresh();
    }
    assert.equal(fetches, 1);
    const audit = openWorkspaceStorage({ workspacePath: root, readOnly: true });
    try {
      const projectId = host.bridge.getSnapshot().selectedProjectId;
      assert.equal(audit.inspectProject(projectId)!.currentBriefVersionId, null);
      assert.equal(audit.listMaterials(projectId).find(material => material.sourceKind === 'web_snapshot')?.content, article);
    } finally { audit.close(); }
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test("project deletion only guards executing runs in the target project, not waiting confirmations elsewhere", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-delete-checkpoint-"));
  const storage = openWorkspaceStorage({ workspacePath: root });
  for (const id of ["waiting", "other", "executing"]) {
    assert.equal(storage.createProject({ operationId: `create-${id}`, projectId: id, name: id,
      mode: "deep", actor: { kind: "user", id: "test" } }).ok, true);
    storage.createSession({ projectId: id, sessionId: `s-${id}`, purpose: "draft" });
    if (id !== "executing") {
      storage.startRun({ projectId: id, sessionId: `s-${id}`, runId: `r-${id}`, planVersion: "test" });
      storage.pauseRun({ projectId: id, runId: `r-${id}`, operationId: `pause-${id}`,
        reason: "CO_CREATION_CHECKPOINT", payload: { stage: "review_editor" } });
    }
  }
  storage.close();
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, "absent.json") });
  try {
    // Start after host startup recovery, which correctly pauses orphaned runs.
    const executing = openWorkspaceStorage({ workspacePath: root });
    executing.startRun({ projectId: "executing", sessionId: "s-executing", runId: "r-executing", planVersion: "test" });
    executing.close();
    await assert.rejects(host.deleteProject("waiting", "wrong"), /PROJECT_DELETE_CONFIRMATION_MISMATCH/);
    await assert.rejects(host.deleteProject("executing", "executing"), /PROJECT_DELETE_RUN_ACTIVE/);
    assert.deepEqual(await host.deleteProject("waiting", "waiting"), { projectId: "waiting", deleted: true });
    assert.deepEqual(host.bridge.getSnapshot().projects.map(p => p.id).sort(), ["executing", "other"]);
    const audit = openWorkspaceStorage({ workspacePath: root, readOnly: true });
    try {
      assert.equal(audit.getRun("r-waiting"), null);
      assert.equal(audit.getRun("r-other")?.status, "waiting_user");
      assert.equal(audit.getRun("r-executing")?.status, "running");
    } finally { audit.close(); }
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

class MemoryCredentials implements SystemCredentialBackend {
  readonly values = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async read(id: string): Promise<string | null> { return this.values.get(id) ?? null; }
  async write(id: string, secret: string): Promise<void> { this.values.set(id, secret); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

test('settings summary does not inspect any credentials; editing inspects only that provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-lazy-'));
  const reads: string[] = [];
  let probes = 0;
  const backend = new MemoryCredentials();
  backend.isAvailable = async () => { probes++; return true; };
  backend.read = async id => { reads.push(id); return 'test-only-secret'; };
  const path = join(root, 'provider.json');
  writeFileSync(path, JSON.stringify({ schemaVersion: 3, activeProfileId: 'p1', profiles: ['p1', 'p2'].map(id => ({
    id, displayName: id, models: ['model'], config: { schemaVersion: 2, kind: 'openai_compatible', providerId: id,
      baseURL: 'https://example.test/v1', model: 'model', tools: 'supported', usage: 'unknown', credentialRef: `managed:${id}` },
  })) }));
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: path,
    credentials: new CredentialBroker({ systemBackend: backend, environment: {} }) });
  try {
    const summary = await host.providerStatus('summary');
    assert.equal(summary.profiles?.length, 2);
    assert.equal(probes, 0, 'listing must not spawn credential probes');
    assert.deepEqual(reads, []);
    assert.ok(summary.profiles?.every(profile => profile.credentialChecked === false));
    const detail = await host.providerDetails('p2');
    assert.equal(detail.configured, true);
    assert.equal(detail.credentialChecked, true);
    assert.deepEqual(reads, ['p2']);
    assert.equal(JSON.stringify({ summary, detail }).includes('test-only-secret'), false);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test("model changes keep a waiting project's session and publish a newer renderer snapshot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-provider-waiting-"));
  const storage = openWorkspaceStorage({ workspacePath: root });
  storage.createProject({ operationId: "p", projectId: "p", name: "旧项目", mode: "deep", actor: { kind: "user", id: "test" } });
  storage.createSession({ projectId: "p", sessionId: "s-old", purpose: "draft" });
  storage.createSession({ projectId: "p", sessionId: "s-new", purpose: "draft" });
  storage.startRun({ projectId: "p", sessionId: "s-old", runId: "r", planVersion: "test" });
  storage.pauseRun({ projectId: "p", runId: "r", operationId: "wait", reason: "CO_CREATION_CHECKPOINT", payload: { stage: "outline" } });
  storage.close();
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, "provider.json"),
    credentials: new CredentialBroker({ environment: {} }) });
  const renderer = new DesktopClientBridge({ invoke: request => dispatchDesktopRpc(host.bridge, request), subscribe: listener => host.subscribe(listener) });
  const unsubscribe = renderer.subscribe(() => undefined);
  try {
    await renderer.handshake();
    await renderer.selectProject("p");
    await renderer.selectSession("p", "s-old");
    await renderer.refresh();
    const before = host.bridge.getSnapshot();
    await host.configureProvider({ kind: "openai_compatible", providerId: "new-provider", baseURL: "https://api.example.test/v1",
      model: "new-model", tools: "supported", usage: "unknown", apiKey: "test-only-key", persistence: "session" });
    const after = host.bridge.getSnapshot();
    assert.equal(after.selectedProjectId, "p");
    assert.equal(after.selectedSessionId, "s-old");
    assert.ok(after.generation > before.generation);
    assert.equal(after.settings.providerLabel, "new-provider · new-model");
    assert.equal(renderer.getSnapshot().settings.providerLabel, "new-provider · new-model");
    assert.equal(renderer.getSnapshot().selectedSessionId, "s-old");
    const audit = openWorkspaceStorage({ workspacePath: root, readOnly: true });
    try { assert.equal(audit.getRun("r")?.status, "waiting_user"); } finally { audit.close(); }
  } finally { unsubscribe(); renderer.dispose(); host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('an existing writing run resumes using the newly selected model without losing its session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-resume-model-'));
  const requests: { model: string; provider: string }[] = [];
  class AskProvider extends ModelProviderBase {
    constructor(id: string) { super(id, 'test', { protocol: 'mock', streaming: 'supported', tools: 'supported', usage: 'unknown' }); }
    protected async *providerStream(request: ModelRequest): AsyncIterable<ProviderStreamEvent> {
      requests.push({ model: request.model, provider: this.id });
      yield { type: 'tool_call_delta', index: 0, id: `ask-${request.requestId}`, name: 'assess_writing_readiness',
        argumentsDelta: JSON.stringify({ status: 'needs_input', reason: '请补充你的看法。', questions: ['你最想表达什么？'] }) };
      yield { type: 'completed', finishReason: 'tool_calls' };
    }
  }
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {} }), providerFactory: config => new AskProvider(config.providerId) });
  const input = { kind: 'openai_compatible' as const, providerId: 'first-provider', baseURL: 'https://example.test/v1',
    model: 'first-model', models: ['first-model', 'second-model'], tools: 'supported' as const, usage: 'unknown' as const, apiKey: 'test', persistence: 'session' as const };
  const wait = async () => {
    for (let i = 0; i < 200; i++) {
      await host.bridge.refresh();
      if (host.bridge.getSnapshot().recoverableRuns.some(run => run.status === 'waiting_user')) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`checkpoint timeout: ${JSON.stringify(host.bridge.getSnapshot().runRecords)}`);
  };
  try {
    const config = await host.configureProvider(input);
    const project = await host.bridge.createProject({ name: '已有项目', mode: 'quick', topic: '个人感想', genre: 'narrative_observation',
      audience: '自己', targetCharacters: 800, constraints: ['不虚构'], interactionMode: 'co_creation', authorVoice: null,
      styleReference: null, styleDecision: 'unspecified', directionDecision: 'user_confirmed', platform: null, publicationGoal: 'not_applicable',
      materials: [{ name: '想法', content: '想记录最近的个人感想。', role: 'source_verified', sourceKind: 'pasted_text', sourceReference: null }] });
    await host.bridge.confirmBrief();
    const run = await host.bridge.sendMessage('开始');
    await wait();
    const before = host.bridge.getSnapshot();
    const count = requests.length;
    assert.ok(count > 0);
    await host.selectProvider(config.activeProfileId!, 'second-model');
    const resumed = await host.bridge.sendMessage('我最想表达的是放慢脚步后看到的新变化。');
    assert.equal(resumed.runId, run.runId);
    await wait();
    assert.ok(requests.length > count);
    assert.ok(requests.slice(count).every(request => request.model === 'second-model'));
    assert.equal(host.bridge.getSnapshot().selectedProjectId, project.projectId);
    assert.equal(host.bridge.getSnapshot().selectedSessionId, before.selectedSessionId);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('executing runs still prevent changing providers or models', async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-active-'));
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: join(root, 'provider.json'),
    credentials: new CredentialBroker({ environment: {} }) });
  const input = { kind: 'openai_compatible' as const, providerId: 'test', baseURL: 'https://example.test/v1',
    model: 'old', tools: 'supported' as const, usage: 'unknown' as const, apiKey: 'test', persistence: 'session' as const };
  try {
    const status = await host.configureProvider(input);
    const storage = openWorkspaceStorage({ workspacePath: root });
    storage.createProject({ operationId: 'p', projectId: 'p', name: '执行中', mode: 'quick', actor: { kind: 'user', id: 'test' } });
    storage.createSession({ projectId: 'p', sessionId: 's', purpose: 'draft' });
    storage.startRun({ projectId: 'p', sessionId: 's', runId: 'r', planVersion: 'test' });
    storage.close();
    await assert.rejects(host.configureProvider({ ...input, model: 'new' }), /ACTIVE_RUNS_PRESENT/);
    await assert.rejects(host.selectProvider(status.activeProfileId!, 'old'), /ACTIVE_RUNS_PRESENT/);
    assert.equal((await host.providerStatus()).model, 'old');
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

test('model catalog is host-only, read-only and never sends a stored key to a changed endpoint', async t => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-models-'));
  const path = join(root, 'provider.json');
  const host = new DesktopApplicationHost({ workspacePath: root, providerProfilePath: path,
    credentials: new CredentialBroker({ environment: {} }) });
  const input = { kind: 'openai_compatible' as const, providerId: 'test', baseURL: 'https://example.test/v1',
    model: 'old', tools: 'supported' as const, usage: 'unknown' as const, apiKey: 'catalog-test-key', persistence: 'session' as const };
  let calls = 0;
  let fail = false;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    calls++;
    assert.equal(url, 'https://example.test/v1/models');
    assert.equal(options.redirect, 'error');
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer catalog-test-key');
    if (fail) throw new Error('private-internal-error');
    return new Response(JSON.stringify({ data: [{ id: 'new' }, { id: 'old' }, { id: 'new' }, { nope: true }] }));
  });
  try {
    const status = await host.configureProvider(input);
    const before = readFileSync(path, 'utf8');
    const query = { ...input, profileId: status.activeProfileId!, apiKey: '' };
    assert.deepEqual(await host.listProviderModels(query), ['new', 'old']);
    assert.equal(readFileSync(path, 'utf8'), before);
    await assert.rejects(host.listProviderModels({ ...query, baseURL: 'https://another.example.test/v1' }),
      error => (error as { code?: string }).code === 'PROVIDER_API_KEY_REQUIRED');
    assert.equal(calls, 1);
    fail = true;
    await assert.rejects(host.listProviderModels(query), /^Error: PROVIDER_CATALOG_UNAVAILABLE$/);
    assert.equal(readFileSync(path, 'utf8'), before);
  } finally { host.close(); rmSync(root, { recursive: true, force: true }); }
});

class UnsupportedProbeProvider extends ModelProviderBase {
  streamCalls = 0;

  constructor() {
    super("example-provider", "probe-test-v1", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(): AsyncIterable<ProviderStreamEvent> {
    this.streamCalls += 1;
    yield {
      type: "error",
      error: {
        code: "MODEL_UNSUPPORTED",
        message: "模型标识不存在或当前账户不可用",
        retryable: false,
      },
    };
  }
}

test("desktop application host switches from unconfigured to a securely managed provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-desktop-host-"));
  const workspacePath = join(root, "workspace");
  const profilePath = join(root, "provider.json");
  const secret = "sk-host-not-real";
  const credentials = new CredentialBroker({
    systemBackend: new MemoryCredentials(),
    environment: {},
  });
  const host = new DesktopApplicationHost({
    workspacePath,
    providerProfilePath: profilePath,
    credentials,
    applicationVersion: "1.0.0-rc.6",
  });
  try {
    const initial = await host.bridge.handshake();
    assert.equal(initial.mock, false);
    assert.equal(initial.clientBuild, "writing-agent-desktop@1.0.0-rc.6");
    assert.match(host.bridge.getSnapshot().settings.providerLabel, /未配置/u);
    assert.equal((await host.providerStatus()).configured, false);

    const status = await host.configureProvider({
      kind: "openai_compatible",
      providerId: "example-provider",
      baseURL: "https://api.example.test/v1",
      model: "example-model",
      tools: "supported",
      usage: "reported",
      apiKey: secret,
      persistence: "system",
    });
    assert.equal(status.configured, true);
    assert.equal(status.providerId, "example-provider");
    assert.equal(status.model, "example-model");
    assert.equal(status.credentialPersistence, "system");
    assert.equal(JSON.stringify(status).includes(secret), false);
    assert.equal(readFileSync(profilePath, "utf8").includes(secret), false);
    assert.equal(host.bridge.getSnapshot().settings.providerLabel, "example-provider · example-model");

    const project = await host.bridge.createProject({
      name: "桌面项目",
      mode: "quick",
      topic: "桌面写作",
      genre: "explanatory_analysis",
      audience: "团队",
      targetCharacters: 800,
      constraints: ["不得虚构数据"],
      interactionMode: "autonomous",
      authorVoice: null,
      styleReference: null,
      styleDecision: "unspecified",
      directionDecision: "tentative",
      platform: null,
      publicationGoal: "not_applicable",
      materials: [{
        name: "输入材料",
        content: "这是用于桌面首启测试的材料。",
        role: "source_verified",
        sourceKind: "pasted_text",
        sourceReference: null,
      }],
    });
    assert.equal(host.bridge.getSnapshot().selectedProjectId, project.projectId);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop application host exposes a safe model connection validation result", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-desktop-probe-"));
  const provider = new UnsupportedProbeProvider();
  const credentials = new CredentialBroker({
    systemBackend: new MemoryCredentials(),
    environment: {},
  });
  const host = new DesktopApplicationHost({
    workspacePath: join(root, "workspace"),
    providerProfilePath: join(root, "provider.json"),
    credentials,
    providerFactory: () => provider,
  });
  try {
    await host.configureProvider({
      kind: "openai_compatible",
      providerId: "example-provider",
      baseURL: "https://api.example.test/v1",
      model: "missing-model",
      tools: "supported",
      usage: "unknown",
      apiKey: "sk-probe-not-real",
      persistence: "system",
    });

    const result = await host.testProviderConnection();
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.stage, "model");
    assert.equal(result.errorCode, "MODEL_UNSUPPORTED");
    assert.equal(result.retryable, false);
    assert.equal(JSON.stringify(result).includes("sk-probe-not-real"), false);
    assert.equal(provider.streamCalls, 1);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop application host previews diagnostics before export and never exposes private content", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-desktop-diagnostics-"));
  const host = new DesktopApplicationHost({
    workspacePath: join(root, "workspace"),
    providerProfilePath: join(root, "provider.json"),
  });
  try {
    const preview = await host.previewDiagnostics();
    assert.deepEqual(preview.includedFiles, [
      "application.json",
      "provider.json",
      "runtime.json",
      "security.json",
    ]);
    assert.equal(preview.excludedDataClasses.includes("article_and_material_content"), true);
    assert.match(preview.confirmationHash, /^[a-f0-9]{64}$/u);

    const outputPath = join(root, "diagnostics.zip");
    const written = await host.writeDiagnostics(outputPath, preview.confirmationHash);
    assert.equal(written.fileName, "diagnostics.zip");
    assert.equal(written.byteLength > 0, true);
    assert.equal(existsSync(outputPath), true);
    assert.equal(JSON.stringify({ preview, written }).includes(root), false);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop application host dry-runs and confirms a read-only legacy import", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-desktop-migration-"));
  const host = new DesktopApplicationHost({
    workspacePath: join(root, "workspace"),
    providerProfilePath: join(root, "provider.json"),
  });
  try {
    const plan = host.planLegacyImport({
      kind: "manifest",
      projectPath: resolve("tests", "fixtures", "legacy", "manifest-project"),
    });
    assert.equal(plan.sourceKind, "manifest");
    assert.equal(plan.projects.length, 1);
    assert.equal(plan.spaceCheck.ok, true);
    assert.equal(JSON.stringify(plan).includes("projectPath"), false);

    const result = await host.applyLegacyImport(plan.planHash);
    assert.equal(result.status, "completed");
    assert.equal(result.sourceUnchanged, true);
    assert.equal(result.projects.length, 1);
    assert.equal(host.bridge.getSnapshot().projects.some(project => project.id === result.projects[0]?.projectId), true);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop application host backs up the workspace and deletes only the exactly confirmed project", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-desktop-user-data-"));
  const host = new DesktopApplicationHost({
    workspacePath: join(root, "workspace"),
    providerProfilePath: join(root, "provider.json"),
  });
  const projectInput = (name: string) => ({
    name,
    mode: "quick" as const,
    topic: `${name}主题`,
    genre: "explanatory_analysis" as const,
    audience: "团队",
    targetCharacters: 800,
    constraints: ["不得虚构"],
    interactionMode: "autonomous" as const,
    authorVoice: null,
    styleReference: null,
    styleDecision: "unspecified" as const,
    directionDecision: "tentative" as const,
    platform: null,
    publicationGoal: "not_applicable" as const,
    materials: [{
      name: "材料",
      content: "本地材料",
      role: "source_verified" as const,
      sourceKind: "pasted_text" as const,
      sourceReference: null,
    }],
  });
  try {
    const first = await host.bridge.createProject(projectInput("待删除项目"));
    const second = await host.bridge.createProject(projectInput("保留项目"));
    const backupPath = join(root, "workspace-backup.sqlite3");
    const backup = await host.writeWorkspaceBackup(backupPath);
    assert.equal(backup.fileName, "workspace-backup.sqlite3");
    assert.equal(backup.byteLength > 0, true);
    assert.equal(existsSync(backupPath), true);

    await assert.rejects(
      host.deleteProject(first.projectId, "错误名称"),
      /PROJECT_DELETE_CONFIRMATION_MISMATCH/u,
    );
    const deleted = await host.deleteProject(first.projectId, "待删除项目");
    assert.deepEqual(deleted, { projectId: first.projectId, deleted: true });
    assert.equal(host.bridge.getSnapshot().projects.some(project => project.id === first.projectId), false);
    assert.equal(host.bridge.getSnapshot().projects.some(project => project.id === second.projectId), true);
  } finally {
    host.close();
    rmSync(root, { recursive: true, force: true });
  }
});
