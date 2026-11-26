import { createHash, randomUUID } from "node:crypto";
import { SearchSettingsStore } from './search-settings.js';
import { createStyleAnalysis, previewStyle } from '../../../packages/application/src/style-analysis.js';
import { STYLE_SAMPLE_LIMIT, ensureStyleSampleCapacity, normalizeStyleUrl, StyleLibraryCommandSchema, type StyleLibraryResult } from '../../../packages/writing-core/src/style-profile.js';
import { evaluateStylePreview } from '../../../packages/writing-core/src/style-package.js';
import { readStyleBatch, readStyleDocument, readStyleUrl } from './style-source.js';
import { styleProviderConfig } from './style-provider.js';
import { DEFAULT_MODEL_GROUPS, MODEL_GROUPS, type GroupModelSelection, type ModelGroupSelections } from '../../../packages/client-bridge/src/model-groups.js';
import type { SearchSettingsInput } from '../../../packages/client-bridge/src/desktop-bridge.js';
import type { SearchProvider } from '../../../packages/writing-core/src/search-providers.js';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { existsSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { WritingApplicationService } from "../../../packages/application/src/index.js";
import type { AuthorWebFetcher } from "../../../packages/application/src/author-web.js";
import {
  createApplicationBridge,
} from "../../../packages/client-bridge/src/application-bridge.js";
import { createFileUiSettingsPersistence } from "../../../packages/client-bridge/src/ui-settings-persistence.js";
import { LocalSettingsRecovery, readLocalSettings } from "../../../packages/client-bridge/src/local-settings-recovery.js";
import type {
  BridgeSnapshot,
  ClientBridge,
} from "../../../packages/client-bridge/src/protocol.js";
import type {
  DesktopProviderConnectionResultView,
  DesktopFailureAnalysisStatus,
  DesktopPublicationSaveInput,
  DesktopPublicationSaveResult,
  DesktopProviderStatusView,
  DesktopSavedProviderView,
} from "../../../packages/client-bridge/src/desktop-bridge.js";
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
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import { assertNoPendingWorkspaceRestore } from "./workspace-restore.js";
import {
  loadDesktopProviderProfile,
  loadDesktopProviderCatalog,
  markDesktopProviderVerified,
  verifiedProviderModels,
  groupProviderConfig,
  configuredGroupProvider,
  type DesktopProviderCatalog,
  parseModelGroups,
  parseModelSelection,
  saveModelGroups,
  selectDesktopProvider,
  previousProvider,
  providerConfigForInput,
  resolveProviderInputKey,
  saveDesktopProviderProfile,
  type DesktopProviderProfileInput,
} from "./provider-profile.js";

import { failureAnalysisContext, parseFailureAnalysisTarget, requestFailureAnalysis, saveFailureAnalysisModel } from "./failure-analysis.js";

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
  readonly authorWebFetcher?: AuthorWebFetcher;
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
  readonly #failureAnalysisModelPath: string;
  readonly #authorWebFetcher: AuthorWebFetcher | undefined;
  readonly #storage;
  readonly #listeners = new Set<(snapshot: BridgeSnapshot) => void>();
  #service: WritingApplicationService;
  #bridge: ClientBridge;
  #bridgeUnsubscribe: (() => void) | null = null;
  #providerConfig: NormalizedProviderConfig | null;
  #connectionTest: DesktopProviderConnectionResultView | null = null;
  #failureAnalysis: AbortController | null = null;
  #closed = false;
  readonly #savedPublications = new Map<string, string>();
  #savingPublication = false;
  #providerChanging = false;
  #styleOperation: AbortController | null = null;
  readonly #searchSettings: SearchSettingsStore;
  readonly #settingsRecovery: LocalSettingsRecovery;

  constructor(options: DesktopApplicationHostOptions) {
    assertNoPendingWorkspaceRestore(options.workspacePath);
    this.#workspacePath = resolve(options.workspacePath);
    this.#providerProfilePath = resolve(options.providerProfilePath);
    this.#credentials = options.credentials ?? createDefaultCredentialBroker();
    this.#settingsRecovery = new LocalSettingsRecovery(join(this.#workspacePath, '.writing-agent', 'logs', 'settings-recovery.jsonl'));
    this.#providerFactory = options.providerFactory ?? createConfiguredProvider;
    this.#applicationVersion = options.applicationVersion ?? "development";
    this.#failureAnalysisModelPath = join(dirname(this.#providerProfilePath), 'failure-analysis-model.json');
    this.#authorWebFetcher = options.authorWebFetcher;
    this.#storage = openWorkspaceStorage({ workspacePath: this.#workspacePath });
    try {
      this.#searchSettings = new SearchSettingsStore(join(dirname(this.#providerProfilePath), 'search-settings.json'), this.#credentials, {}, this.#settingsRecovery);
      this.#providerConfig = loadDesktopProviderProfile(this.#providerProfilePath, this.#settingsRecovery);
      const runtime = this.#createRuntime(loadDesktopProviderCatalog(this.#providerProfilePath, this.#settingsRecovery), "");
      this.#service = runtime.service;
      this.#bridge = runtime.bridge;
      this.#service.recoverWorkspace();
      this.#attachBridgeEvents();
    } catch (error) {
      this.#storage.close();
      throw error;
    }
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

  async styleLibrary(input: unknown, chooseDocument?: () => Promise<string | readonly string[] | null>): Promise<StyleLibraryResult> {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    const parsed = StyleLibraryCommandSchema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues.some(issue => issue.message === 'STYLE_SAMPLE_LIMIT_EXCEEDED') ? 'STYLE_SAMPLE_LIMIT_EXCEEDED' : 'STYLE_INPUT_INVALID');
    const command = parsed.data;
    const store = this.#storage.styleProfiles();
    if (command.action === 'cancel') {
      this.#styleOperation?.abort(new Error('STYLE_ANALYSIS_CANCELLED'));
      return { profiles: store.list(), cancelled: true };
    }
    if (command.action === 'list') return { profiles: store.list() };
    if (command.action === 'get') return { profiles: store.list(), profile: store.get(command.id) };
    if (command.action === 'selection') return { profiles: store.list(), selection: this.#service.getProjectStyleSelection(command.projectId) ?? null };
    if (command.action === 'select') {
      this.#service.selectProjectStyle(command.projectId, command.selection, `select-style:${randomUUID()}`);
      await this.#bridge.refresh();
      return { profiles: store.list(), selection: this.#service.getProjectStyleSelection(command.projectId) ?? null };
    }
    if (this.#styleOperation) throw new Error('STYLE_LIBRARY_BUSY');
    if (command.action === 'save') return { profile: store.save(command.id, command.expectedVersion, command.draft), profiles: store.list() };
    if (command.action === 'delete') { store.remove(command.id, command.expectedVersion); return { profiles: store.list() }; }
    if (this.#providerChanging) throw new Error('PROVIDER_SETTINGS_BUSY');
    const controller = new AbortController();
    this.#styleOperation = controller;
    try {
      let result: Omit<StyleLibraryResult, 'profiles'>;
      if (command.action === 'source') {
        result = { sample: await readStyleUrl(command.url, controller.signal, this.#authorWebFetcher) };
      } else if (command.action === 'sources') {
        const urls = [...new Set(command.urls.map(normalizeStyleUrl))];
        ensureStyleSampleCapacity(STYLE_SAMPLE_LIMIT - (command.remainingSlots ?? STYLE_SAMPLE_LIMIT), urls.length);
        result = { items: await readStyleBatch(urls.map(url => ({ label: url, read: () => readStyleUrl(url, controller.signal, this.#authorWebFetcher) })), controller.signal, 'STYLE_SOURCE_FAILED') };
      } else if (command.action === 'import') {
        if (!chooseDocument) throw new Error('STYLE_DOCUMENT_PICKER_REQUIRED');
        const selected = await chooseDocument();
        if (controller.signal.aborted) throw new Error('STYLE_ANALYSIS_CANCELLED');
        const paths = [...new Set(typeof selected === 'string' ? [selected] : selected ?? [])];
        ensureStyleSampleCapacity(STYLE_SAMPLE_LIMIT - (command.remainingSlots ?? STYLE_SAMPLE_LIMIT), paths.length);
        if (!paths.length) result = { cancelled: true };
        else if (typeof selected === 'string') result = { sample: await readStyleDocument(selected) };
        else result = { items: await readStyleBatch(paths.map(path => ({ label: basename(path), read: () => readStyleDocument(path) })), controller.signal, 'STYLE_DOCUMENT_READ_FAILED') };
      } else {
        const config = groupProviderConfig(loadDesktopProviderCatalog(this.#providerProfilePath), 'style_modeler');
        const provider = this.#providerFactory(styleProviderConfig(config), this.#credentials);
        const options = { provider, model: config.model, signal: controller.signal };
        if (command.action === 'analyze') result = { draft: await createStyleAnalysis({ ...options, name: command.name, samples: command.samples }) };
        else {
          const preview = await previewStyle({ ...options, card: command.card, topic: command.topic, ...(command.package ? { package: command.package } : {}) });
          result = { preview, evaluation: evaluateStylePreview(preview, command.package) };
        }
      }
      if (this.#closed || controller.signal.aborted) throw new Error('STYLE_ANALYSIS_CANCELLED');
      return { ...result, profiles: store.list() };
    } finally { if (this.#styleOperation === controller) this.#styleOperation = null; }
  }
  async configureSearch(input: SearchSettingsInput) { return this.#searchSettings.save(input); }
  async testSearchConnection(provider: SearchProvider) { return this.#searchSettings.verify(provider); }

  async providerDetails(profileId: string): Promise<DesktopSavedProviderView> {
    const profile = loadDesktopProviderCatalog(this.#providerProfilePath).profiles.find(p => p.id === profileId);
    if (!profile) throw new Error('PROVIDER_PROFILE_NOT_FOUND');
    const metadata = await this.#credentials.inspect(profile.config.credentialRef);
    return { profileId: profile.id, displayName: profile.displayName, models: profile.models,
      kind: profile.config.kind, providerId: profile.config.providerId, baseURL: profile.config.baseURL,
      model: profile.config.model, tools: profile.config.tools, usage: profile.config.usage,
      configured: metadata.configured, credentialPersistence: metadata.persistence, credentialChecked: true,
      verifiedModels: verifiedProviderModels(profile), verifiedAt: verifiedProviderModels(profile)[profile.config.model] ?? null };
  }

  async providerStatus(mode?: 'summary' | 'active'): Promise<DesktopProviderStatus> {
    const config = this.#providerConfig;
    const catalog = loadDesktopProviderCatalog(this.#providerProfilePath, this.#settingsRecovery);
    const metadataById = new Map<string, Awaited<ReturnType<CredentialBroker['inspect']>>>();
    const profiles = await Promise.all(catalog.profiles.map(async profile => {
      const checked = mode !== 'summary' && (mode !== 'active' || profile.id === catalog.activeProfileId);
      const metadata = checked ? await this.#credentials.inspect(profile.config.credentialRef) : null;
      if (metadata) metadataById.set(profile.id, metadata);
      return { profileId: profile.id, displayName: profile.displayName, models: profile.models,
        kind: profile.config.kind, providerId: profile.config.providerId, baseURL: profile.config.baseURL,
        model: profile.config.model, tools: profile.config.tools, usage: profile.config.usage,
        configured: metadata?.configured ?? false, credentialPersistence: metadata?.persistence ?? 'missing' as const,
        credentialChecked: checked, verifiedModels: verifiedProviderModels(profile), verifiedAt: verifiedProviderModels(profile)[profile.config.model] ?? null };
    }));
    if (config === null) {
      return {
        activeProfileId: catalog.activeProfileId, profiles, modelGroups: catalog.modelGroups ?? DEFAULT_MODEL_GROUPS,
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
      activeProfileId: catalog.activeProfileId, profiles, modelGroups: catalog.modelGroups ?? DEFAULT_MODEL_GROUPS,
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
    return this.#changeProvider(async prepare =>
      (await saveDesktopProviderProfile(this.#providerProfilePath, this.#credentials, input, prepare)).config, true);
  }

  async selectProvider(profileId: string, model: string): Promise<DesktopProviderStatus> {
    return this.#changeProvider(async prepare => {
      const profile = loadDesktopProviderCatalog(this.#providerProfilePath).profiles.find(entry => entry.id === profileId);
      if (!profile || !(await this.#credentials.inspect(profile.config.credentialRef)).configured) throw new Error('PROVIDER_API_KEY_REQUIRED');
      return selectDesktopProvider(this.#providerProfilePath, profileId, model, prepare);
    }, true);
  }

  async configureModelGroups(groups: ModelGroupSelections): Promise<DesktopProviderStatus> {
    groups = parseModelGroups(groups);
    return this.#changeProvider(async prepare => {
      const config = this.#providerConfig;
      if (!config) throw new Error('MODEL_PROVIDER_REQUIRED');
      const catalog = loadDesktopProviderCatalog(this.#providerProfilePath);
      for (const { id } of MODEL_GROUPS) {
        const selection = groups[id];
        if (!selection) continue;
        const previous = catalog.modelGroups?.[id];
        if (previous?.profileId === selection.profileId && previous.model === selection.model) continue;
        const profile = catalog.profiles.find(p => p.id === selection.profileId);
        if (!profile || !(await this.#credentials.inspect(profile.config.credentialRef)).configured) throw new Error('PROVIDER_API_KEY_REQUIRED');
      }
      saveModelGroups(this.#providerProfilePath, groups, candidate => prepare(config, candidate));
      return config;
    });
  }

  async failureAnalysisStatus(): Promise<DesktopFailureAnalysisStatus> {
    const selection = this.#readFailureAnalysisModel();
    const status = await this.providerStatus();
    const choices = (status.profiles ?? []).flatMap(profile => profile.configured
      ? profile.models.filter(model => Object.hasOwn(profile.verifiedModels ?? {}, model)).map(model => ({
        selection: { profileId: profile.profileId, model },
        label: `${profile.displayName} / ${model}`,
      })) : []);
    const notice = selection === null ? this.#settingsRecovery.notices.findLast(message => message.startsWith('报错分析设置')) : undefined;
    return { selection, choices, ...(notice ? { notice } : {}) };
  }

  async configureFailureAnalysisModel(input: unknown): Promise<DesktopFailureAnalysisStatus> {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    const selection = parseModelSelection(input);
    this.#readFailureAnalysisModel();
    this.#settingsRecovery.assertWritable(this.#failureAnalysisModelPath);
    if (selection) await this.#analysisProviderConfig(selection);
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    saveFailureAnalysisModel(this.#failureAnalysisModelPath, selection);
    return this.failureAnalysisStatus();
  }

  async analyzeRunFailure(input: unknown) {
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    if (this.#failureAnalysis) throw new Error('FAILURE_ANALYSIS_BUSY');
    const target = parseFailureAnalysisTarget(input);
    const context = failureAnalysisContext(this.bridge.getSnapshot(), target, this.#applicationVersion);
    const selection = this.#readFailureAnalysisModel();
    if (!selection) throw new Error('FAILURE_ANALYSIS_MODEL_REQUIRED');
    const controller = new AbortController();
    this.#failureAnalysis = controller;
    try {
      const config = await this.#analysisProviderConfig(selection);
      if (controller.signal.aborted) throw controller.signal.reason;
      return await requestFailureAnalysis(this.#providerFactory(config, this.#credentials), config.model, context, controller.signal);
    } finally {
      this.#failureAnalysis = null;
    }
  }

  #readFailureAnalysisModel(): GroupModelSelection | null {
    return readLocalSettings(this.#failureAnalysisModelPath, 'failureAnalysis', null, parseModelSelection, this.#settingsRecovery);
  }

  async #analysisProviderConfig(selection: GroupModelSelection): Promise<NormalizedProviderConfig> {
    const profile = loadDesktopProviderCatalog(this.#providerProfilePath, this.#settingsRecovery).profiles
      .find(candidate => candidate.id === selection.profileId);
    if (!profile || !Object.hasOwn(verifiedProviderModels(profile), selection.model) ||
      !(await this.#credentials.inspect(profile.config.credentialRef)).configured) throw new Error('FAILURE_ANALYSIS_MODEL_UNAVAILABLE');
    return { ...profile.config, model: selection.model };
  }

  async #changeProvider(change: (prepare: (config: NormalizedProviderConfig, catalog: DesktopProviderCatalog) => void) => Promise<NormalizedProviderConfig>,
    validateProfile = false): Promise<DesktopProviderStatus> {
    this.#settingsRecovery.assertWritable(this.#providerProfilePath);
    if (this.#closed) throw new Error('DESKTOP_HOST_CLOSED');
    if (this.#providerChanging) throw new Error('PROVIDER_SETTINGS_BUSY');
    if (this.#hasExecutingRun()) throw new Error('ACTIVE_RUNS_PRESENT');
    this.#providerChanging = true;
    let runtime: { service: WritingApplicationService; bridge: ClientBridge } | undefined;
    try {
      const before = this.#bridge.getSnapshot();
      const config = await change((candidate, catalog) => {
        runtime = this.#createRuntime(catalog, before.selectedProjectId, before, validateProfile ? candidate : undefined);
      });
      if (!runtime) throw new Error('PROVIDER_RUNTIME_NOT_PREPARED');
      this.#bridgeUnsubscribe?.();
      this.#bridge.dispose();
      this.#providerConfig = config;
      this.#connectionTest = null;
      this.#service = runtime.service;
      this.#bridge = runtime.bridge;
      runtime = undefined;
      this.#attachBridgeEvents();
    } catch (error) {
      runtime?.bridge.dispose();
      throw error;
    } finally { this.#providerChanging = false; }
    // Only the installed, committed runtime may recover pending decisions.
    await this.#bridge.refresh();
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

  async testProviderConnection(target?: GroupModelSelection): Promise<DesktopProviderConnectionResultView> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    if (this.#providerChanging) throw new Error('PROVIDER_SETTINGS_BUSY');
    if (this.#hasExecutingRun()) throw new Error("ACTIVE_RUNS_PRESENT");
    const catalog = loadDesktopProviderCatalog(this.#providerProfilePath);
    const profile = catalog.profiles.find(p => p.id === (target?.profileId ?? catalog.activeProfileId));
    if (target && (!profile || !profile.models.includes(target.model))) throw new Error('PROVIDER_PROFILE_NOT_FOUND');
    const config = target && profile ? { ...profile.config, model: target.model } : this.#providerConfig;
    if (config === null) throw new Error("MODEL_PROVIDER_REQUIRED");
    const testedProfileId = profile?.id ?? null;
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
    if (testedProfileId === loadDesktopProviderCatalog(this.#providerProfilePath).activeProfileId && JSON.stringify(config) === JSON.stringify(this.#providerConfig)) this.#connectionTest = connectionTest;
    if (testedProfileId !== null) {
      markDesktopProviderVerified(this.#providerProfilePath, testedProfileId, config, connectionTest.ok && connectionTest.tools === 'supported');
      const updated = loadDesktopProviderCatalog(this.#providerProfilePath, this.#settingsRecovery);
      const ready = MODEL_GROUPS.every(({ id }) => configuredGroupProvider(updated, id) !== null);
      const configured = this.#bridge.getSnapshot().settings.credentialReference !== null;
      const current = this.#providerConfig;
      if (ready !== configured && current && !this.#closed && !this.#providerChanging && !this.#hasExecutingRun()) {
        await this.#changeProvider(async prepare => { prepare(current, updated); return current; });
      }
    }
    return connectionTest;
  }

  #assertRecoverySelection(projectId: unknown): asserts projectId is string {
    const snapshot = this.bridge.getSnapshot();
    if (typeof projectId !== 'string' || projectId !== snapshot.selectedProjectId ||
        !snapshot.projects.some(project => project.id === projectId && project.readIssue)) {
      throw new Error('PROJECT_RECOVERY_SELECTION_CHANGED');
    }
  }

  async repairProjectFromBackup(projectId: unknown, choosePath: () => Promise<string | null>): Promise<{ cancelled: boolean; message?: string }> {
    this.#assertRecoverySelection(projectId);
    const path = await choosePath();
    if (path === null) return { cancelled: true };
    this.#assertRecoverySelection(projectId);
    if (this.#hasExecutingRun(projectId)) throw new Error('PROJECT_REPAIR_BUSY');
    const result = this.#service.repairProjectFromBackup(projectId, path);
    await this.#bridge.recheckProject!(projectId);
    const needsRepair = this.bridge.getSnapshot().projects.find(project => project.id === projectId)?.readIssue;
    const evidence = result.evidencePath ? ` 修复前的数据保存在工作区的 .writing-agent/project-repairs/${basename(result.evidencePath)}。` : '';
    return { cancelled: false, message: (result.status === 'repaired' ? '已从同版本备份修复本项目的记录。' : '本次没有可替换的简报或正文记录。')
      + (needsRepair ? ' 该项目还有其他读取错误，可继续导出原始数据。' : ' 项目已可打开。') + evidence };
  }

  async exportProjectRecovery(projectId: unknown, choosePath: () => Promise<string | null>): Promise<{ cancelled: boolean; fileName?: string }> {
    this.#assertRecoverySelection(projectId);
    const selected = await choosePath();
    if (selected === null) return { cancelled: true };
    this.#assertRecoverySelection(projectId);
    if (!isAbsolute(selected) || extname(selected).toLowerCase() !== '.json') throw new Error('PROJECT_RECOVERY_DESTINATION_INVALID');
    const destination = join(realpathSync(dirname(selected)), basename(selected));
    const relativeToData = relative(realpathSync(join(this.#workspacePath, '.writing-agent')), destination);
    const insideData = !isAbsolute(relativeToData) && relativeToData !== '..' && !relativeToData.startsWith('..' + sep);
    const isConfig = [this.#providerProfilePath, join(dirname(this.#providerProfilePath), 'search-settings.json')]
      .some(path => relative(destination, path) === '');
    if (insideData || isConfig) throw new Error('PROJECT_RECOVERY_DESTINATION_INVALID');
    const temporary = join(dirname(destination), '.writing-agent-recovery-' + randomUUID() + '.tmp');
    try {
      const payload = this.#service.exportProjectRecovery(projectId);
      writeFileSync(temporary, payload, { encoding: 'utf8', flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, destination);
    } catch (cause) {
      process.stderr.write('Writing Agent project recovery export failed\n');
      throw new Error('PROJECT_RECOVERY_EXPORT_FAILED', { cause });
    } finally {
      rmSync(temporary, { force: true });
    }
    return { cancelled: false, fileName: basename(destination) };
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
      // Export reads a version-bound snapshot of this project. Other projects,
      // and runs that are merely waiting for feedback, cannot change this file.
      if (this.#hasExecutingRun(input.projectId)) throw new Error('EXPORT_WRITING_ACTIVE');
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

  async writeWorkspaceBackup(
    outputPath: string,
  ): Promise<{ readonly fileName: string; readonly byteLength: number; readonly sha256: string; readonly schemaVersion: number }> {
    if (this.#closed) throw new Error("DESKTOP_HOST_CLOSED");
    // A saved question awaiting the author has no active writer. It may belong
    // to the very project that needs a safety backup before recovery.
    if (this.#hasExecutingRun()) throw new Error("ACTIVE_RUNS_PRESENT");
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
    if (this.#storage.listRuns(projectId).some(
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

  hasWorkBeforeRestart(): boolean {
    return this.#styleOperation !== null || this.#failureAnalysis !== null || this.#storage.hasRunInStates(['queued', 'running']);
  }

  close(): void {
    if (this.#closed) return;
    this.#styleOperation?.abort(new Error('STYLE_ANALYSIS_CANCELLED'));
    this.#failureAnalysis?.abort(new Error('DESKTOP_HOST_CLOSED'));
    this.#closed = true;
    this.#bridgeUnsubscribe?.();
    this.#bridgeUnsubscribe = null;
    this.#bridge.dispose();

    this.#listeners.clear();
    this.#savedPublications.clear();
    this.#storage.close();
  }

  #createRuntime(
    catalog: DesktopProviderCatalog,
    initialProjectId: string,
    previous?: BridgeSnapshot,
    profileToValidate?: NormalizedProviderConfig,
  ): { service: WritingApplicationService; bridge: ClientBridge } {
    const providers = new Map<string, ModelProvider>();
    const providerFor = (selected: NormalizedProviderConfig) => {
      const key = JSON.stringify(selected);
      let selectedProvider = providers.get(key);
      if (!selectedProvider) { selectedProvider = this.#providerFactory(selected, this.#credentials); providers.set(key, selectedProvider); }
      return selectedProvider;
    };
    // Keep provider configuration transactional even before a model is assigned to a group.
    if (profileToValidate) providerFor(profileToValidate);
    const startModel = MODEL_GROUPS.every(({ id }) => configuredGroupProvider(catalog, id) !== null)
      ? groupProviderConfig(catalog, 'intake') : null;
    const provider = startModel ? providerFor(startModel) : undefined;
    const resolveModel = (actor?: string) => {
      // Profile selection for connection testing never participates in writing routes.
      const selected = groupProviderConfig(loadDesktopProviderCatalog(this.#providerProfilePath, this.#settingsRecovery), actor);
      return { provider: providerFor(selected), model: selected.model };
    };
    const service = new WritingApplicationService({
      storage: this.#storage,
      factSearchConfiguration: () => this.#searchSettings.configuration(),
      ...(this.#authorWebFetcher ? { authorWebFetcher: this.#authorWebFetcher } : {}),
      ...(provider === undefined ? {} : { provider }),
      resolveModel,
    });
    const bridge = createApplicationBridge({
      service,
      workspaceId: workspaceId(this.#workspacePath),
      model: {
        model: startModel?.model ?? "not-configured",
        providerLabel: startModel ? "角色模型已配置" : "请为三档选择模型",
        credentialReference: startModel?.credentialRef ?? null,
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
      startupNotices: this.#settingsRecovery.notices,
      initialProjectId,
      deferHandoffsUntilRefresh: previous !== undefined,
      ...(previous === undefined ? {} : { initialSessionId: previous.selectedSessionId, initialGeneration: previous.generation + 1 }),
      uiSettingsPersistence: createFileUiSettingsPersistence({
        filePath: join(this.#workspacePath, ".writing-agent", "ui-settings.json"),
        recovery: this.#settingsRecovery,
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

  #hasExecutingRun(projectId?: string): boolean {
    if (projectId === undefined && this.#styleOperation !== null) return true;
    return this.#storage.hasRunInStates(['queued', 'running', 'paused'], projectId);
  }
}
