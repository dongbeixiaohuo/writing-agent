import { createHash, randomUUID } from "node:crypto";
import { SearchSettingsStore } from './search-settings.js';
import type { FactSearchConfiguration } from '../../../packages/application/src/fact-search.js';
import type { SearchSettingsInput } from '../../../packages/client-bridge/src/desktop-bridge.js';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { WritingApplicationService } from "../../../packages/application/src/index.js";
import {
  createApplicationBridge,
} from "../../../packages/client-bridge/src/application-bridge.js";
import { createFileUiSettingsPersistence } from "../../../packages/client-bridge/src/ui-settings-persistence.js";
import type {
  BridgeSnapshot,
  ClientBridge,
} from "../../../packages/client-bridge/src/protocol.js";
import type {
  DesktopProviderConnectionResultView,
  DesktopDiagnosticPreviewView,
  DesktopLegacyMigrationPlanView,
  DesktopLegacyMigrationResultView,
  DesktopPublicationSaveInput,
  DesktopPublicationSaveResult,
  DesktopProviderStatusView,
  DesktopSavedProviderView,
} from "../../../packages/client-bridge/src/desktop-bridge.js";
import {
  applyLegacyMigration,
  planLegacyMigration,
  type LegacyMigrationPlan,
  type LegacySourceSpec,
} from "../../../packages/legacy-migration/src/index.js";
import {
  CredentialBroker,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  createConfiguredProvider,
  createDefaultCredentialBroker,
  type NormalizedProviderConfig,
} from "../../../packages/runtime/provider-config/src/index.js";
import {
  probeModelConnection,
  type ModelProvider,
} from "../../../packages/runtime/llm/src/index.js";
import {
  prepareDiagnosticBundle,
  writeDiagnosticBundle,
  type PreparedDiagnosticBundle,
} from "../../../packages/runtime/diagnostics/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import {
  loadDesktopProviderProfile,
  loadDesktopProviderCatalog,
  markDesktopProviderVerified,
  selectDesktopProvider,
  previousProvider,
  providerConfigForInput,
  resolveProviderInputKey,
  saveDesktopProviderProfile,
  type DesktopProviderProfileInput,
} from "./provider-profile.js";

const ACTIVE_RUN_STATUSES = new Set(["queued", "running", "paused", "waiting_user"]);

export interface DesktopProviderStatus extends DesktopProviderStatusView {
  readonly configured: boolean;
  readonly kind: NormalizedProviderConfig["kind"] | null;
  readonly providerId: string | null;
  readonly baseURL: string | null;
  readonly model: string | null;
  readonly tools: "supported" | "unsupported" | null;
  readonly usage: "reported" | "unknown" | null;
  readonly credentialReference: string | null;
  readonly credentialPersistence: "system" | "session" | "environment" | "missing";
  readonly fallbackReason: "system_unavailable" | "system_write_failed" | null;
  readonly connectionTest: DesktopProviderConnectionResultView | null;
}

export interface DesktopApplicationHostOptions {
  readonly workspacePath: string;
  readonly providerProfilePath: string;
  readonly credentials?: CredentialBroker;
  readonly providerFactory?: (
    config: NormalizedProviderConfig,
    credentials: CredentialBroker,
  ) => ModelProvider;
  readonly applicationVersion?: string;
  readonly applicationBuild?: string;
  readonly authorizeFactSearchQuery?: FactSearchConfiguration['authorizeQuery'];
}

function workspaceId(path: string): string {
  return `workspace-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}`;
}

export class DesktopApplicationHost {
  readonly #workspacePath: string;
  readonly #providerProfilePath: string;
  readonly #credentials: CredentialBroker;
  readonly #providerFactory: NonNullable<DesktopApplicationHostOptions["providerFactory"]>;
  readonly #applicationVersion: string;
  readonly #applicationBuild: string;
  readonly #storage;
  readonly #listeners = new Set<(snapshot: BridgeSnapshot) => void>();
  #service: WritingApplicationService;
  #bridge: ClientBridge;
  #bridgeUnsubscribe: (() => void) | null = null;
  #providerConfig: NormalizedProviderConfig | null;
  #connectionTest: DesktopProviderConnectionResultView | null = null;
  #preparedDiagnostics: PreparedDiagnosticBundle | null = null;
  #legacyPlan: LegacyMigrationPlan | null = null;
  #closed = false;
  readonly #savedPublications = new Map<string, string>();
  #savingPublication = false;
  #providerChanging = false;
  readonly #searchSettings: SearchSettingsStore;
  readonly #authorizeFactSearchQuery: FactSearchConfiguration['authorizeQuery'];

  constructor(options: DesktopApplicationHostOptions) {
    this.#workspacePath = resolve(options.workspacePath);
    this.#providerProfilePath = resolve(options.providerProfilePath);
    this.#credentials = options.credentials ?? createDefaultCredentialBroker();
    this.#authorizeFactSearchQuery = options.authorizeFactSearchQuery;
    this.#searchSettings = new SearchSettingsStore(join(dirname(this.#providerProfilePath), 'search-settings.json'), this.#credentials);
    this.#providerFactory = options.providerFactory ?? createConfiguredProvider;
    this.#applicationVersion = options.applicationVersion ?? "development";
    this.#applicationBuild = options.applicationBuild ?? "writing-agent-desktop-v1";
    this.#storage = openWorkspaceStorage({ workspacePath: this.#workspacePath });
    this.#providerConfig = loadDesktopProviderProfile(this.#providerProfilePath);
    const runtime = this.#createRuntime(this.#providerConfig, "");
    this.#service = runtime.service;
    this.#bridge = runtime.bridge;
    this.#service.recoverWorkspace();
    this.#attachBridgeEvents();
  }

  get bridge(): ClientBridge {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#providerChanging) throw new Error("PROVIDER_SETTINGS_BUSY");
    return this.#bridge;
  }

  subscribe(listener: (snapshot: BridgeSnapshot) => void): () => void {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async searchStatus() { return this.#searchSettings.status(); }
  async configureSearch(input: SearchSettingsInput) { return this.#searchSettings.save(input); }

  async providerDetails(profileId: string): Promise<DesktopSavedProviderView> {
    const profile = loadDesktopProviderCatalog(this.#providerProfilePath).profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('PROVIDER_PROFILE_NOT_FOUND');
    const metadata = await this.#credentials.inspect(profile.config.credentialRef);
    return { profileId: profile.id, displayName: profile.displayName, models: profile.models,
      kind: profile.config.kind, providerId: profile.config.providerId, baseURL: profile.config.baseURL,
      model: profile.config.model, tools: profile.config.tools, usage: profile.config.usage,
      configured: metadata.configured, credentialPersistence: metadata.persistence, credentialChecked: true,
      verifiedAt: profile.verifiedAt ?? null };
  }

  async providerStatus(mode?: 'summary' | 'active'): Promise<DesktopProviderStatus> {
    const config = this.#providerConfig;
    const catalog = loadDesktopProviderCatalog(this.#providerProfilePath);
    const metadataById = new Map<string, Awaited<ReturnType<CredentialBroker['inspect']>>>();
    const profiles = await Promise.all(catalog.profiles.map(async profile => {
      const checked = mode !== 'summary' && (mode !== 'active' || profile.id === catalog.activeProfileId);
      const metadata = checked ? await this.#credentials.inspect(profile.config.credentialRef) : null;
      if (metadata) metadataById.set(profile.id, metadata);
      return { profileId: profile.id, displayName: profile.displayName, models: profile.models,
        kind: profile.config.kind, providerId: profile.config.providerId, baseURL: profile.config.baseURL,
        model: profile.config.model, tools: profile.config.tools, usage: profile.config.usage,
        configured: metadata?.configured ?? false, credentialPersistence: metadata?.persistence ?? 'missing' as const,
        credentialChecked: checked, verifiedAt: profile.verifiedAt ?? null };
    }));
    if (config === null) {
      return {
        activeProfileId: catalog.activeProfileId, profiles,
        configured: false,
        kind: null,
        providerId: null,
        baseURL: null,
        model: null,
        tools: null,
        usage: null,
        credentialReference: null,
        credentialPersistence: "missing",
        fallbackReason: null,
        connectionTest: null,
      };
    }
    const credential = metadataById.get(catalog.activeProfileId ?? '');
    return {
      activeProfileId: catalog.activeProfileId, profiles,
      configured: credential?.configured ?? false,
      credentialChecked: credential !== undefined,
      kind: config.kind,
      providerId: config.providerId,
      baseURL: config.baseURL,
      model: config.model,
      tools: config.tools,
      usage: config.usage,
      credentialReference: config.credentialRef,
      credentialPersistence: credential?.persistence ?? 'missing',
      fallbackReason: credential?.fallbackReason ?? null,
      connectionTest: this.#connectionTest,
    };
  }

  async configureProvider(
    input: DesktopProviderProfileInput,
  ): Promise<DesktopProviderStatus> {
    return this.#changeProvider(async () => (await saveDesktopProviderProfile(this.#providerProfilePath, this.#credentials, input)).config);
  }

  async selectProvider(profileId: string, model: string): Promise<DesktopProviderStatus> {
    return this.#changeProvider(async () => {
      const profile = loadDesktopProviderCatalog(this.#providerProfilePath).profiles.find(entry => entry.id === profileId);
      if (!profile || !(await this.#credentials.inspect(profile.config.credentialRef)).configured) throw new Error('PROVIDER_API_KEY_REQUIRED');
      return selectDesktopProvider(this.#providerProfilePath, profileId, model);
    });
  }

  async #changeProvider(change: () => Promise<NormalizedProviderConfig>): Promise<DesktopProviderStatus> {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    if (this.#providerChanging) throw new Error('PROVIDER_SETTINGS_BUSY');
    if (this.#hasExecutingRun()) throw new Error('ACTIVE_RUNS_PRESENT');
    this.#providerChanging = true;
    try {
      const before = this.#bridge.getSnapshot();
      const config = await change();
      const runtime = this.#createRuntime(config, before.selectedProjectId, before);
      this.#bridgeUnsubscribe?.();
      this.#bridge.dispose();
      this.#providerConfig = config;
      this.#connectionTest = null;
      this.#service = runtime.service;
      this.#bridge = runtime.bridge;
      this.#attachBridgeEvents();
    } finally { this.#providerChanging = false; }
    this.#emit();
    return this.providerStatus('active');
  }

  async listProviderModels(input: DesktopProviderProfileInput): Promise<readonly string[]> {
    const previous = previousProvider(loadDesktopProviderCatalog(this.#providerProfilePath), input);
    const config = providerConfigForInput(input, previous?.config);
    const key = await resolveProviderInputKey(this.#credentials, input, config, previous?.config);
    const headers: Record<string, string> = config.kind === 'anthropic_compatible'
      ? { 'anthropic-version': config.anthropicVersion ?? '2023-06-01',
          ...(config.authHeader === 'authorization' ? { authorization: `Bearer ${key}` } : { 'x-api-key': key }) }
      : { authorization: `Bearer ${key}` };
    try {
      const response = await fetch(`${config.baseURL.replace(/\/+$/u, '')}/models`, {
        headers, redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || !response.body) throw new Error('CATALOG_UNAVAILABLE');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1_048_576) throw new Error('CATALOG_TOO_LARGE');
          chunks.push(part.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!data || typeof data !== 'object' || !('data' in data) || !Array.isArray(data.data)) throw new Error('CATALOG_INVALID');
      const ids = data.data.flatMap((item: unknown) => item && typeof item === 'object' && 'id' in item &&
        typeof item.id === 'string' && item.id.trim().length > 0 && item.id.length <= 256 ? [item.id.trim()] : []);
      if (!ids.length) throw new Error('CATALOG_EMPTY');
      return [...new Set(ids)].sort().slice(0, 500);
    } catch { throw new Error('PROVIDER_CATALOG_UNAVAILABLE'); }
  }

  async testProviderConnection(): Promise<DesktopProviderConnectionResultView> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#providerChanging) throw new Error('PROVIDER_SETTINGS_BUSY');
    if (this.#hasExecutingRun()) throw new Error("ACTIVE_RUNS_PRESENT");
    const config = this.#providerConfig;
    if (config === null) throw new Error("MODEL_PROVIDER_REQUIRED");
    const provider = this.#providerFactory(config, this.#credentials);
    const result = await probeModelConnection(provider, {
      requestId: `desktop-connection-${randomUUID()}`,
      model: config.model,
      testTools: true,
    });
    const connectionTest: DesktopProviderConnectionResultView = result.ok
      ? {
          ok: true,
          provider: result.provider,
          model: result.model,
          adapterVersion: result.adapterVersion,
          streaming: result.streaming,
          tools: result.tools,
          usage: result.usage,
        }
      : {
          ok: false,
          provider: result.provider,
          model: result.model,
          adapterVersion: result.adapterVersion,
          stage: result.stage,
          errorCode: result.error.code,
          retryable: result.error.retryable,
          ...(result.error.providerDetail === undefined ? {} : { providerDetail: result.error.providerDetail }),
        };
    if (config === this.#providerConfig) this.#connectionTest = connectionTest;
    if (connectionTest.ok) {
      const activeProfileId = loadDesktopProviderCatalog(this.#providerProfilePath).activeProfileId;
      if (activeProfileId !== null) {
        try { markDesktopProviderVerified(this.#providerProfilePath, activeProfileId); } catch { /* keep the test result even if the stamp fails */ }
      }
    }
    return connectionTest;
  }

  async previewDiagnostics(): Promise<DesktopDiagnosticPreviewView> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    const provider = await this.providerStatus();
    const latestRun = this.#service
      .listProjects()
      .flatMap((project) => this.#service.getProjectProjection(project.id).runs)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .at(-1);
    const prepared = prepareDiagnosticBundle({
      application: {
        version: this.#applicationVersion,
        build: this.#applicationBuild,
        platform: process.platform,
        arch: process.arch,
      },
      provider: {
        id: provider.providerId ?? "not-configured",
        protocol: provider.kind ?? "not-configured",
        model: provider.model ?? "not-configured",
        capabilities: {
          streaming: provider.configured,
          tools: provider.tools ?? "unknown",
          usage: provider.usage ?? "unknown",
        },
        connection: provider.connectionTest === null
          ? { status: "not_tested", errorCode: "UNKNOWN" }
          : provider.connectionTest.ok
            ? { status: "ok", errorCode: "UNKNOWN" }
            : { status: "failed", errorCode: provider.connectionTest.errorCode },
      },
      runtime: latestRun === undefined
        ? {
            status: "idle",
            stopReason: null,
          }
        : {
            status: latestRun.status,
            stopReason: latestRun.stopReason,
            counts: {
              modelCalls: latestRun.usage.modelRequests,
              retries: latestRun.usage.retries,
              toolCalls: latestRun.usage.toolCalls,
              majorRevisions: latestRun.usage.majorRevisions,
            },
            budget: {
              maxModelSteps: latestRun.budget.maxModelRequests,
              maxRetries: latestRun.budget.maxRetriesPerRequest,
              maxToolCalls: latestRun.budget.maxToolCalls,
              maxMajorRevisions: latestRun.budget.maxMajorRevisions,
            },
            usage: {
              inputTokens: latestRun.usage.inputTokens,
              outputTokens: latestRun.usage.outputTokens,
              cost: latestRun.usage.costKnown && latestRun.usage.cost !== null
                ? {
                    status: "known",
                    amount: latestRun.usage.cost.amount,
                    currency: latestRun.usage.cost.currency,
                    priceVersion: latestRun.usage.cost.pricingVersion,
                    verifiedAt: latestRun.usage.cost.verifiedAt,
                  }
                : { status: "unknown" },
            },
          },
      security: {
        credentialPersistence: provider.credentialPersistence,
        systemCredentialStoreAvailable: provider.credentialPersistence === "system",
        networkPolicy: "enforced",
        externalContentTrust: "external_untrusted",
        htmlActiveContent: "removed",
        rendererDirectProviderAccess: false,
        upstreamTelemetryEnabled: false,
      },
    }, {
      sections: ["application", "provider", "runtime", "security"],
    });
    this.#preparedDiagnostics = prepared;
    return prepared.manifest;
  }

  async savePublicationAs(
    input: DesktopPublicationSaveInput,
    choosePath: (fileName: string) => Promise<string | null>,
  ): Promise<DesktopPublicationSaveResult> {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    if (!input || typeof input.projectId !== 'string' || typeof input.bodyVersionId !== 'string' ||
        !['html', 'txt'].includes(input.format) || !['clean', 'editorial', 'compact'].includes(input.layoutPreset)) {
      throw new Error('EXPORT_DESTINATION_INVALID');
    }
    if (this.#savingPublication) throw new Error('EXPORT_ALREADY_SAVING');
    const assertCurrent = () => {
      const snapshot = this.#bridge.getSnapshot();
      if (snapshot.selectedProjectId !== input.projectId || snapshot.deliveryWorkspace.bodyVersionId !== input.bodyVersionId) {
        throw new Error('EXPORT_SELECTION_CHANGED');
      }
      if (this.#hasActiveRun()) throw new Error('EXPORT_WRITING_ACTIVE');
      if (!snapshot.deliveryWorkspace.formalExportEnabled || snapshot.deliveryWorkspace.gateStatus !== 'passed') {
        throw new Error('FACT_GATE_NOT_PASSED');
      }
      return snapshot;
    };
    this.#savingPublication = true;
    try {
      await this.#bridge.refresh();
      const snapshot = assertCurrent();
      const rawTitle = snapshot.previewDocument.title.replace(/[<>:"/\\|?*\x00-\x1f]/gu, '_').replace(/[. ]+$/gu, '').slice(0, 100) || '文章';
      const title = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(rawTitle) ? `文章-${rawTitle}` : rawTitle;
      const selectedPath = await choosePath(`${title}.${input.format}`);
      if (selectedPath === null) return { cancelled: true };
      await this.#bridge.refresh();
      assertCurrent();
      // Native dialog owns the destination. Reject workspace files, even via a linked directory.
      const destination = resolve(selectedPath);
      if (!isAbsolute(selectedPath) || extname(destination).toLowerCase() !== `.${input.format}`) throw new Error('EXPORT_DESTINATION_INVALID');
      const canonical = existsSync(destination) ? realpathSync(destination) : join(realpathSync(dirname(destination)), basename(destination));
      const inside = relative(realpathSync(this.#workspacePath), canonical);
      if (!inside || (inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))) throw new Error('EXPORT_DESTINATION_INVALID');
      const record = await this.#bridge.exportPublication(input.format, { layoutPreset: input.layoutPreset });
      assertCurrent();
      if (record.state !== 'completed' || record.mode !== 'publication') throw new Error('EXPORT_SAVE_FAILED');
      const source = realpathSync(resolve(this.#workspacePath, record.relativePath));
      const sourceRelative = relative(realpathSync(join(this.#workspacePath, 'exports')), source);
      if (!sourceRelative || sourceRelative.startsWith('..') || isAbsolute(sourceRelative)) throw new Error('EXPORT_SAVE_FAILED');
      const content = readFileSync(source);
      if (createHash('sha256').update(content).digest('hex') !== record.contentHash) throw new Error('EXPORT_SAVE_FAILED');
      const temporary = join(dirname(destination), `.writing-agent-export-${randomUUID()}.tmp`);
      try {
        writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
        renameSync(temporary, destination);
      } catch {
        throw new Error('EXPORT_SAVE_FAILED');
      } finally { rmSync(temporary, { force: true }); }
      const receiptId = randomUUID();
      this.#savedPublications.set(receiptId, destination);
      return { cancelled: false, receiptId, savedPath: destination, fileName: basename(destination) };
    } finally { this.#savingPublication = false; }
  }

  publicationSavedPath(receiptId: string): string {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    const path = this.#savedPublications.get(receiptId);
    if (path === undefined || !existsSync(path)) throw new Error('EXPORT_RECEIPT_NOT_FOUND');
    return path;
  }

  providerConfigPath(): string {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    return this.#providerProfilePath;
  }

  async writeDiagnostics(
    outputPath: string,
    confirmationHash: string,
  ): Promise<{ readonly fileName: string; readonly byteLength: number; readonly sha256: string }> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    const prepared = this.#preparedDiagnostics;
    if (prepared === null) throw new Error("DIAGNOSTIC_PREPARATION_REQUIRED");
    const written = writeDiagnosticBundle(prepared, {
      outputDirectory: dirname(resolve(outputPath)),
      fileName: basename(outputPath),
      confirmationHash,
    });
    this.#preparedDiagnostics = null;
    return {
      fileName: basename(written.outputPath),
      byteLength: written.byteLength,
      sha256: written.sha256,
    };
  }

  planLegacyImport(source: LegacySourceSpec): DesktopLegacyMigrationPlanView {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#hasActiveRun()) throw new Error("ACTIVE_RUNS_PRESENT");
    const plan = planLegacyMigration({
      source,
      targetWorkspacePath: this.#workspacePath,
    });
    this.#legacyPlan = plan;
    return {
      planHash: plan.planHash,
      sourceKind: plan.source.kind,
      createdAt: plan.createdAt,
      projects: plan.projects.map((project) => ({
        name: project.name,
        mode: project.mode,
        artifactCount: project.artifactCount,
        legacyFactStatus: project.legacyFactStatus,
        migratedFactStatus: project.migratedFactStatus,
        styleStatus: project.styleStatus,
      })),
      credentialDisposition: plan.credentialDisposition,
      warnings: plan.warnings,
      spaceCheck: plan.spaceCheck,
    };
  }

  async applyLegacyImport(planHash: string): Promise<DesktopLegacyMigrationResultView> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#hasActiveRun()) throw new Error("ACTIVE_RUNS_PRESENT");
    const plan = this.#legacyPlan;
    if (plan === null || plan.planHash !== planHash) {
      throw new Error("MIGRATION_CONFIRMATION_MISMATCH");
    }
    const report = await applyLegacyMigration({ plan });
    this.#legacyPlan = null;
    await this.#bridge.refresh();
    return {
      status: report.status,
      sourceKind: report.sourceKind,
      sourceUnchanged: report.sourceUnchanged,
      projects: report.projects.map((project) => ({
        projectId: project.targetProjectId,
        name: plan.projects.find(candidate => candidate.targetProjectId === project.targetProjectId)?.name ?? "已迁移项目",
        artifactVersionCount: project.artifactVersionCount,
        factGateStatus: project.factGateStatus,
        styleStatus: project.styleStatus,
      })),
    };
  }

  async writeWorkspaceBackup(
    outputPath: string,
  ): Promise<{ readonly fileName: string; readonly byteLength: number; readonly sha256: string; readonly schemaVersion: number }> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#hasActiveRun()) throw new Error("ACTIVE_RUNS_PRESENT");
    const backup = await this.#storage.createBackup(resolve(outputPath));
    return {
      fileName: basename(backup.path),
      byteLength: backup.sizeBytes,
      sha256: backup.sha256,
      schemaVersion: backup.schemaVersion,
    };
  }

  async deleteProject(
    projectId: string,
    confirmedName: string,
  ): Promise<{ readonly projectId: string; readonly deleted: true }> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    const project = this.#storage.inspectProject(projectId);
    if (project === null) throw new Error("PROJECT_NOT_FOUND");
    if (confirmedName.trim() !== project.name) {
      throw new Error("PROJECT_DELETE_CONFIRMATION_MISMATCH");
    }
    // Waiting/paused runs have no in-flight writer. A confirmed project deletion
    // includes those records; unrelated projects must not veto this operation.
    if (this.#service.getProjectProjection(projectId).runs.some(
      (run) => run.status === "queued" || run.status === "running",
    )) throw new Error("PROJECT_DELETE_RUN_ACTIVE");
    const deleted = this.#storage.deleteProject({
      operationId: randomUUID(),
      projectId,
      expectedProjectRevision: project.revision,
      confirmedProjectId: projectId,
      actor: { kind: "user", id: "desktop-user" },
    });
    if (!deleted.ok) {
      throw Object.assign(new Error(deleted.code), { code: deleted.code });
    }
    await this.#bridge.refresh();
    return deleted.result;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#bridge.dispose();
    this.#preparedDiagnostics = null;
    this.#legacyPlan = null;
    this.#listeners.clear();
    this.#savedPublications.clear();
    this.#storage.close();
  }

  #createRuntime(
    config: NormalizedProviderConfig | null,
    initialProjectId: string,
    previous?: BridgeSnapshot,
  ): { service: WritingApplicationService; bridge: ClientBridge } {
    const provider = config === null
      ? undefined
      : this.#providerFactory(config, this.#credentials);
    const service = new WritingApplicationService({
      storage: this.#storage,
      factSearchConfiguration: () => ({ ...this.#searchSettings.configuration(),
        ...(this.#authorizeFactSearchQuery ? { authorizeQuery: this.#authorizeFactSearchQuery } : {}) }),
      ...(provider === undefined ? {} : { provider }),
    });
    const bridge = createApplicationBridge({
      service,
      workspaceId: workspaceId(this.#workspacePath),
      model: {
        model: config?.model ?? "not-configured",
        providerLabel:
          config === null
            ? "尚未配置模型"
            : `${config.providerId} · ${config.model}`,
        credentialReference: config?.credentialRef ?? null,
        parameters: { temperature: 0, toolChoice: "auto" },
        budget: {
          maxModelRequests: 64,
          maxToolCalls: 96,
          maxRetriesPerRequest: 2,
          maxMajorRevisions: 2,
        },
      },
      clientBuild: `writing-agent-desktop@${this.#applicationVersion}`,
      runtimeBuild: "writing-agent-runtime-v1",
      initialProjectId,
      ...(previous === undefined ? {} : { initialSessionId: previous.selectedSessionId, initialGeneration: previous.generation + 1 }),
      uiSettingsPersistence: createFileUiSettingsPersistence({
        filePath: join(this.#workspacePath, ".writing-agent", "ui-settings.json"),
      }),
    });
    return { service, bridge };
  }

  #attachBridgeEvents(): void {
    this.#bridgeUnsubscribe = this.#bridge.subscribe(() => this.#emit());
  }

  #emit(): void {
    const snapshot = this.#bridge.getSnapshot();
    for (const listener of this.#listeners) listener(snapshot);
  }

  #hasActiveRun(): boolean {
    return this.#service.listProjects().some((project) =>
      this.#service
        .getProjectProjection(project.id)
        .runs.some((run) => ACTIVE_RUN_STATUSES.has(run.status)),
    );
  }

  #hasExecutingRun(): boolean {
    return this.#service.listProjects().some(project => this.#service.getProjectProjection(project.id).runs
      .some(run => run.status === 'queued' || run.status === 'running' || run.status === 'paused'));
  }
}
