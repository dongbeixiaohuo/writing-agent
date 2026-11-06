import { createHash, randomUUID } from "node:crypto";
import { MODEL_GROUPS, modelGroupForActor, type ModelGroupSelections } from '../../../packages/client-bridge/src/model-groups.js';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type {
  CredentialBroker,
  CredentialMetadata,
  CredentialPersistence,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  parseProviderConfig,
  type NormalizedProviderConfig,
} from "../../../packages/runtime/provider-config/src/index.js";
import type { DesktopProviderSetupInput } from "../../../packages/client-bridge/src/desktop-bridge.js";
import { PROVIDER_PRESETS } from "../../../packages/client-bridge/src/provider-presets.js";

export interface DesktopProviderProfileInput extends DesktopProviderSetupInput {
  readonly persistence: CredentialPersistence;
  readonly allowInsecureHttp?: boolean;
  readonly anthropicVersion?: string;
  readonly authHeader?: "x-api-key" | "authorization";
  readonly defaultMaxOutputTokens?: number;
}

export interface SavedDesktopProviderProfile {
  readonly config: NormalizedProviderConfig;
  readonly credential: CredentialMetadata;
}

const desktopProviderProfileSchema = z.object({
  profileId: z.string().min(1).max(128).nullable().optional(),
  displayName: z.string().trim().min(1).max(128).optional(),
  models: z.array(z.string().trim().min(1).max(256)).min(1).max(100).optional(),
  kind: z.enum(["openai_compatible", "openai_responses", "anthropic_compatible"]),
  providerId: z.string().trim().min(1).max(128),
  baseURL: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(256),
  tools: z.enum(["supported", "unsupported"]),
  usage: z.enum(["reported", "unknown"]),
  apiKey: z.string().max(65536),
  persistence: z.enum(["system", "session"]),
  anthropicVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  authHeader: z.enum(["x-api-key", "authorization"]).optional(),
  defaultMaxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
}).strict();

function providerProfileError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

export function parseDesktopProviderProfileInput(value: unknown): DesktopProviderProfileInput {
  const parsed = desktopProviderProfileSchema.safeParse(value);
  if (!parsed.success) {
    throw providerProfileError(
      "DESKTOP_PROVIDER_INPUT_INVALID",
      "Desktop provider configuration is invalid",
    );
  }
  const { anthropicVersion, authHeader, defaultMaxOutputTokens, profileId, displayName, models, ...base } = parsed.data;
  return {
    ...base,
    ...(profileId === undefined ? {} : { profileId }),
    ...(displayName === undefined ? {} : { displayName }),
    ...(models === undefined ? {} : { models }),
    ...(anthropicVersion === undefined ? {} : { anthropicVersion }),
    ...(authHeader === undefined ? {} : { authHeader }),
    ...(defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens }),
  };
}

function assertTransport(baseURL: string): URL {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw providerProfileError("PROVIDER_URL_INVALID", "Provider URL is invalid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw providerProfileError("PROVIDER_URL_INVALID", "Provider URL must use HTTP or HTTPS");
  }
  return url;
}

export function loadDesktopProviderProfile(
  filePathInput: string,
): NormalizedProviderConfig | null {
  const catalog = loadDesktopProviderCatalog(filePathInput);
  return catalog.profiles.find(profile => profile.id === catalog.activeProfileId)?.config ?? null;
}

export interface SavedProviderEntry {
  readonly verifications?: Readonly<Record<string, { readonly fingerprint: string; readonly verifiedAt: string }>> | undefined;
  readonly id: string;
  readonly displayName: string;
  readonly models: readonly string[];
  readonly config: NormalizedProviderConfig;
  // Compatibility stamp for the selected model; configuration changes invalidate it.
  readonly verifiedAt?: string | undefined;
}

export interface DesktopProviderCatalog {
  readonly modelGroups?: ModelGroupSelections;
  readonly schemaVersion: 3;
  readonly activeProfileId: string | null;
  readonly profiles: readonly SavedProviderEntry[];
}

const groupSelectionSchema = z.object({ profileId: z.string().min(1).max(128), model: z.string().min(1).max(256) }).strict().nullable();
const modelGroupsSchema = z.object({ planning: groupSelectionSchema, writing: groupSelectionSchema, review: groupSelectionSchema }).strict();
const catalogSchema = z.object({
  modelGroups: modelGroupsSchema.optional(),
  schemaVersion: z.literal(3), activeProfileId: z.string().nullable(),
  profiles: z.array(z.object({
    id: z.string().min(1).max(128), displayName: z.string().min(1).max(128),
    models: z.array(z.string().min(1).max(256)).min(1).max(100), config: z.unknown(),
    verifiedAt: z.string().max(64).optional(),
    verifications: z.record(z.string(), z.object({ fingerprint: z.string().length(64), verifiedAt: z.string().max(64) }).strict()).optional(),
  }).strict()).max(50),
}).strict();

// Profiles saved before a preset gained reviewed vendor request fields keep
// working: when a stored config still exactly matches that preset family
// (provider id + endpoint), the preset's extraBody is filled at read time
// without rewriting the file. DeepSeek's thinking toggle is endpoint-level
// semantics (its thinking mode rejects tool_choice="required" on Chat,
// Responses and Anthropic), so for this additive field the match is by
// normalized endpoint only, covering custom-saved configs at the same
// unambiguous endpoint. Modified addresses no longer match and get nothing.
function normalizeEndpointForMatch(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/u, '').replace(/\/v1$/u, '');
}

function withPresetExtraBody(config: NormalizedProviderConfig): NormalizedProviderConfig {
  if (config.extraBody !== undefined) return config;
  if (config.kind !== 'openai_compatible' && config.kind !== 'openai_responses' && config.kind !== 'anthropic_compatible') return config;
  const endpoint = normalizeEndpointForMatch(config.baseURL);
  const preset = PROVIDER_PRESETS.find(item =>
    normalizeEndpointForMatch(item.baseURL) === endpoint && item.extraBody !== undefined);
  return preset?.extraBody === undefined ? config : parseProviderConfig({ ...config, extraBody: preset.extraBody });
}

export function loadDesktopProviderCatalog(filePathInput: string): DesktopProviderCatalog {
  const filePath = resolve(filePathInput);
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    if (typeof value === 'object' && value !== null && 'schemaVersion' in value && value.schemaVersion === 3) {
      const parsed = catalogSchema.parse(value);
      const profiles = parsed.profiles.map(profile => ({ ...profile, config: withPresetExtraBody(parseProviderConfig(profile.config)) }));
      if (new Set(profiles.map(profile => profile.id)).size !== profiles.length ||
        !profiles.some(profile => profile.id === parsed.activeProfileId) ||
        profiles.some(profile => !profile.models.includes(profile.config.model))) throw new Error('INVALID_CATALOG');
      return { schemaVersion: 3, activeProfileId: parsed.activeProfileId, profiles,
        ...(parsed.modelGroups ? { modelGroups: parsed.modelGroups } : {}) };
    }
    const config = withPresetExtraBody(parseProviderConfig(value));
    // Read legacy files without rewriting them or moving their managed Key.
    return { schemaVersion: 3, activeProfileId: 'legacy-primary', profiles: [
      { id: 'legacy-primary', displayName: config.providerId, models: [config.model], config },
    ] };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) return { schemaVersion: 3, activeProfileId: null, profiles: [] };
    throw providerProfileError(
      "DESKTOP_PROVIDER_PROFILE_INVALID",
      "Desktop provider profile is invalid",
    );
  }
}

function writeCatalog(filePathInput: string, catalog: DesktopProviderCatalog): void {
  catalogSchema.parse(catalog);
  const filePath = resolve(filePathInput);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(catalog, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, filePath);
  } finally { rmSync(temporaryPath, { force: true }); }
}

// Stamp a profile as connection-verified without touching its stored config;
// preset extraBody fill-in stays a read-time concern (see withPresetExtraBody).
export function markDesktopProviderVerified(filePathInput: string, profileId: string, testedConfig?: NormalizedProviderConfig, ok = true): void {
  const filePath = resolve(filePathInput);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
  if (typeof value !== 'object' || value === null || !('schemaVersion' in value) || value.schemaVersion !== 3) return;
  const catalog = value as DesktopProviderCatalog;
  if (!catalog.profiles.some(profile => profile.id === profileId)) return;
  const normalized = loadDesktopProviderCatalog(filePath).profiles.find(p => p.id === profileId)!;
  const tested = testedConfig ?? normalized.config;
  if (!normalized.models.includes(tested.model) || providerFingerprint({ ...normalized.config, model: tested.model }) !== providerFingerprint(tested)) return;
  const verifications = { ...normalized.verifications };
  // Preserve a legacy verified current model when first recording another model.
  if (normalized.verifiedAt && !verifications[normalized.config.model]) verifications[normalized.config.model] = {
    fingerprint: providerFingerprint(normalized.config), verifiedAt: normalized.verifiedAt,
  };
  if (ok) verifications[tested.model] = { fingerprint: providerFingerprint(tested), verifiedAt: new Date().toISOString() };
  else delete verifications[tested.model];
  writeCatalog(filePath, {
    ...catalog,
    profiles: catalog.profiles.map(profile => profile.id === profileId
      ? { ...profile, verifications, verifiedAt: verifications[normalized.config.model]?.verifiedAt }
      : profile),
  });
}

function providerFingerprint(config: NormalizedProviderConfig): string {
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
    : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)])) : value;
  return createHash('sha256').update(JSON.stringify(stable(parseProviderConfig(config)))).digest('hex');
}

export function verifiedProviderModels(profile: SavedProviderEntry): Record<string, string> {
  const result: Record<string, string> = {};
  for (const model of profile.models) {
    const verification = profile.verifications?.[model];
    if (verification?.fingerprint === providerFingerprint({ ...profile.config, model })) result[model] = verification.verifiedAt;
  }
  // Legacy stamps applied only to the selected model, never all profile models.
  if (!profile.verifications && profile.verifiedAt) result[profile.config.model] = profile.verifiedAt;
  return result;
}

export function parseModelGroups(value: unknown): ModelGroupSelections {
  const result = modelGroupsSchema.safeParse(value);
  if (!result.success) throw providerProfileError('MODEL_GROUPS_INVALID', 'Invalid model group selection');
  return result.data;
}

export function groupProviderConfig(catalog: DesktopProviderCatalog, fallback: NormalizedProviderConfig | null, actor?: string): NormalizedProviderConfig | null {
  const group = modelGroupForActor(actor);
  const selection = catalog.modelGroups?.[group];
  if (!selection) return fallback;
  const profile = catalog.profiles.find(p => p.id === selection.profileId);
  if (!profile || !verifiedProviderModels(profile)[selection.model] || profile.config.tools !== 'supported') {
    throw providerProfileError('MODEL_GROUP_UNAVAILABLE', `${MODEL_GROUPS.find(g => g.id === group)!.label}的模型未通过验证，请在模型设置中重新验证或选择。`);
  }
  return parseProviderConfig({ ...profile.config, model: selection.model });
}

export function saveModelGroups(filePath: string, input: unknown, beforeCommit?: (catalog: DesktopProviderCatalog) => void): void {
  const catalog = loadDesktopProviderCatalog(filePath);
  const modelGroups = parseModelGroups(input);
  const candidate = { ...catalog, modelGroups };
  for (const actor of ['director', 'draft', 'fact_check']) groupProviderConfig(candidate, null, actor);
  beforeCommit?.(candidate);
  writeCatalog(filePath, candidate);
}

export function previousProvider(catalog: DesktopProviderCatalog, input: DesktopProviderSetupInput): SavedProviderEntry | undefined {
  if (input.profileId === null) return undefined;
  const profile = catalog.profiles.find(candidate => candidate.id === (input.profileId ?? catalog.activeProfileId));
  if (input.profileId !== undefined && profile === undefined) throw providerProfileError('PROVIDER_PROFILE_NOT_FOUND', 'Saved provider is unavailable');
  return profile;
}

export function providerConfigForInput(input: DesktopProviderProfileInput, previous?: NormalizedProviderConfig): NormalizedProviderConfig {
  const transport = assertTransport(input.baseURL);
  const sameTransport = previous?.kind === input.kind && previous.baseURL === input.baseURL.trim().replace(/\/+$/u, '');
  const preset = PROVIDER_PRESETS.find(item => item.id === input.providerId && item.kind === input.kind
    && item.baseURL === input.baseURL.trim().replace(/\/+$/u, ''));
  // Metadata only supplies authentication for a new transport; editing a
  // working saved profile preserves its authentication unless explicitly set.
  const authHeader = input.authHeader ?? (sameTransport && previous.kind === 'anthropic_compatible'
    ? previous.authHeader : preset?.authHeader);
  // Vendor request fields likewise: keep the existing profile's on the same
  // transport, otherwise adopt the preset's reviewed adaptation (e.g.
  // DeepSeek thinking disabled). Never carried across different endpoints.
  const extraBody = (input.kind !== 'openai_compatible' && input.kind !== 'anthropic_compatible') ? undefined
    : (sameTransport && (previous?.kind === 'openai_compatible' || previous?.kind === 'anthropic_compatible') ? previous.extraBody : undefined) ?? preset?.extraBody;
  const config = parseProviderConfig({ schemaVersion: 2, kind: input.kind, providerId: input.providerId,
    baseURL: input.baseURL, model: input.model, tools: input.tools, usage: input.usage,
    credentialRef: previous?.credentialRef ?? 'managed:pending',
    // Entering an HTTP endpoint in desktop settings authorizes that transport.
    // Persist it so discovery, probes and all role-bound adapters agree after restart.
    ...(transport.protocol === 'http:' ? { allowInsecureHttp: true } : {}),
    ...(extraBody === undefined ? {} : { extraBody }),
    ...(input.kind === 'anthropic_compatible' ? {
      ...(input.anthropicVersion === undefined ? {} : { anthropicVersion: input.anthropicVersion }),
      ...(authHeader === undefined ? {} : { authHeader }),
      ...(input.defaultMaxOutputTokens === undefined ? {} : { defaultMaxOutputTokens: input.defaultMaxOutputTokens }),
    } : {}),
  });
  if (config.kind === 'anthropic_compatible' && previous?.kind === config.kind && previous.baseURL === config.baseURL) {
    return parseProviderConfig({ ...config, anthropicVersion: input.anthropicVersion ?? previous.anthropicVersion,
      authHeader: input.authHeader ?? previous.authHeader,
      defaultMaxOutputTokens: input.defaultMaxOutputTokens ?? previous.defaultMaxOutputTokens });
  }
  return config;
}

export async function resolveProviderInputKey(credentials: CredentialBroker, input: DesktopProviderProfileInput,
  config: NormalizedProviderConfig, previous?: NormalizedProviderConfig): Promise<string> {
  if (input.apiKey.trim()) return input.apiKey.trim();
  if (previous?.kind === config.kind && previous.baseURL === config.baseURL) {
    const key = await credentials.resolve(previous.credentialRef);
    if (key) return key;
  }
  throw providerProfileError('PROVIDER_API_KEY_REQUIRED', 'Enter a key for this provider endpoint');
}

export async function saveDesktopProviderProfile(
  filePathInput: string,
  credentials: CredentialBroker,
  input: DesktopProviderProfileInput,
  beforeCommit?: (config: NormalizedProviderConfig) => void,
): Promise<SavedDesktopProviderProfile> {
  const catalog = loadDesktopProviderCatalog(filePathInput);
  const previous = previousProvider(catalog, input);
  const config = providerConfigForInput(input, previous?.config);
  const secret = await resolveProviderInputKey(credentials, input, config, previous?.config);
  const newKey = input.apiKey.trim().length > 0;
  // A fresh credential reference keeps other providers and in-flight reads intact.
  const credential = newKey
    ? await credentials.saveManaged(`desktop-${randomUUID()}`, secret, input.persistence)
    : await credentials.inspect(config.credentialRef);
  const savedConfig = parseProviderConfig({ ...config, credentialRef: credential.reference });
  const models = [...new Set([...(input.models ?? previous?.models ?? []), input.model])];
  // Display names and catalog additions do not change an already tested model.
  // A different endpoint, credential reference or request configuration does.
  const verifications = Object.fromEntries(Object.entries(previous ? verifiedProviderModels(previous) : {})
    .filter(([model]) => models.includes(model) && providerFingerprint({ ...previous!.config, model }) === providerFingerprint({ ...savedConfig, model }))
    .map(([model, verifiedAt]) => [model, { fingerprint: providerFingerprint({ ...savedConfig, model }), verifiedAt }]));
  const profile: SavedProviderEntry = { id: previous?.id ?? randomUUID(),
    displayName: input.displayName ?? previous?.displayName ?? input.providerId,
    models, config: savedConfig, verifications, verifiedAt: verifications[savedConfig.model]?.verifiedAt };
  try {
    // Validate the replacement runtime before publishing the catalog. A fresh
    // key remains private to the candidate and is removed if preparation fails.
    beforeCommit?.(savedConfig);
    writeCatalog(filePathInput, { ...catalog, schemaVersion: 3, activeProfileId: profile.id,
      profiles: [...catalog.profiles.filter(candidate => candidate.id !== profile.id), profile] });
  } catch (error) {
    if (newKey) await credentials.deleteManaged(credential.reference.slice('managed:'.length)).catch(() => undefined);
    throw error;
  }
  return { config: savedConfig, credential };
}

export function selectDesktopProvider(filePath: string, profileId: string, model: string,
  beforeCommit?: (config: NormalizedProviderConfig) => void): NormalizedProviderConfig {
  const catalog = loadDesktopProviderCatalog(filePath);
  const profile = catalog.profiles.find(entry => entry.id === profileId);
  if (!profile || !profile.models.includes(model)) throw providerProfileError('PROVIDER_PROFILE_NOT_FOUND', 'Saved provider or model is unavailable');
  const config = parseProviderConfig({ ...profile.config, model });
  const { verifiedAt, ...unverified } = profile;
  const verifications = { ...profile.verifications };
  if (!profile.verifications && verifiedAt) verifications[profile.config.model] = { fingerprint: providerFingerprint(profile.config), verifiedAt };
  beforeCommit?.(config);
  writeCatalog(filePath, { ...catalog, activeProfileId: profile.id,
    profiles: catalog.profiles.map(entry => entry.id === profile.id
      ? { ...unverified, verifications, verifiedAt: verifiedProviderModels(profile)[model], config } : entry) });
  return config;
}
