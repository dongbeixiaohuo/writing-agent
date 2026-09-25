import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  CredentialBroker,
  type SystemCredentialBackend,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  ModelProviderBase,
  type ProviderStreamEvent,
} from "../../../packages/runtime/llm/src/index.js";
import { DesktopApplicationHost } from "../src/application-host.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";

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
