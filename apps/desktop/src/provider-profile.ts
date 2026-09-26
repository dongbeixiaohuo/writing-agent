import { randomUUID } from "node:crypto";
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

function assertTransport(baseURL: string, allowInsecureHttp: boolean): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw providerProfileError("PROVIDER_URL_INVALID", "Provider URL is invalid");
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && allowInsecureHttp) return;
  throw providerProfileError(
    "INSECURE_PROVIDER_URL_REJECTED",
    "Provider URL must use HTTPS",
  );
}

export function loadDesktopProviderProfile(
  filePathInput: string,
): NormalizedProviderConfig | null {
  const catalog = loadDesktopProviderCatalog(filePathInput);
  return catalog.profiles.find(profile => profile.id === catalog.activeProfileId)?.config ?? null;
}

export interface SavedProviderEntry {
  readonly id: string;
  readonly displayName: string;
  readonly models: readonly string[];
  readonly config: NormalizedProviderConfig;
}

export interface DesktopProviderCatalog {
  readonly schemaVersion: 3;
  readonly activeProfileId: string | null;
  readonly profiles: readonly SavedProviderEntry[];
}

const catalogSchema = z.object({
  schemaVersion: z.literal(3), activeProfileId: z.string().nullable(),
  profiles: z.array(z.object({
    id: z.string().min(1).max(128), displayName: z.string().min(1).max(128),
    models: z.array(z.string().min(1).max(256)).min(1).max(100), config: z.unknown(),
  }).strict()).max(50),
}).strict();

// Profiles saved before a preset gained reviewed vendor request fields keep
// working: when a stored config still exactly matches that preset family
// (provider id + endpoint), the preset's extraBody is filled at read time
// without rewriting the file. DeepSeek's thinking toggle is protocol-level
// (its thinking mode rejects tool_choice="required" on both Chat and
// Responses), so the match ignores wire protocol for this additive field.
// Modified addresses no longer match and get nothing.
function withPresetExtraBody(config: NormalizedProviderConfig): NormalizedProviderConfig {
  if (config.extraBody !== undefined) return config;
  if (config.kind !== 'openai_compatible' && config.kind !== 'openai_responses') return config;
  const preset = PROVIDER_PRESETS.find(item => item.id === config.providerId
    && item.baseURL === config.baseURL.replace(/\/+$/u, '') && item.extraBody !== undefined);
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
      return { schemaVersion: 3, activeProfileId: parsed.activeProfileId, profiles };
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

export function previousProvider(catalog: DesktopProviderCatalog, input: DesktopProviderSetupInput): SavedProviderEntry | undefined {
  if (input.profileId === null) return undefined;
  const profile = catalog.profiles.find(candidate => candidate.id === (input.profileId ?? catalog.activeProfileId));
  if (input.profileId !== undefined && profile === undefined) throw providerProfileError('PROVIDER_PROFILE_NOT_FOUND', 'Saved provider is unavailable');
  return profile;
}

export function providerConfigForInput(input: DesktopProviderProfileInput, previous?: NormalizedProviderConfig): NormalizedProviderConfig {
  assertTransport(input.baseURL, input.allowInsecureHttp === true);
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
  const extraBody = input.kind !== 'openai_compatible' ? undefined
    : (sameTransport && previous?.kind === 'openai_compatible' ? previous.extraBody : undefined) ?? preset?.extraBody;
  const config = parseProviderConfig({ schemaVersion: 2, kind: input.kind, providerId: input.providerId,
    baseURL: input.baseURL, model: input.model, tools: input.tools, usage: input.usage,
    credentialRef: previous?.credentialRef ?? 'managed:pending',
    ...(input.allowInsecureHttp === undefined ? {} : { allowInsecureHttp: input.allowInsecureHttp }),
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
  const profile: SavedProviderEntry = { id: previous?.id ?? randomUUID(),
    displayName: input.displayName ?? previous?.displayName ?? input.providerId,
    models: [...new Set([...(input.models ?? previous?.models ?? []), input.model])], config: savedConfig };
  try {
    writeCatalog(filePathInput, { schemaVersion: 3, activeProfileId: profile.id,
      profiles: [...catalog.profiles.filter(candidate => candidate.id !== profile.id), profile] });
  } catch (error) {
    if (newKey) await credentials.deleteManaged(credential.reference.slice('managed:'.length)).catch(() => undefined);
    throw error;
  }
  return { config: savedConfig, credential };
}

export function selectDesktopProvider(filePath: string, profileId: string, model: string): NormalizedProviderConfig {
  const catalog = loadDesktopProviderCatalog(filePath);
  const profile = catalog.profiles.find(entry => entry.id === profileId);
  if (!profile || !profile.models.includes(model)) throw providerProfileError('PROVIDER_PROFILE_NOT_FOUND', 'Saved provider or model is unavailable');
  const config = parseProviderConfig({ ...profile.config, model });
  writeCatalog(filePath, { ...catalog, activeProfileId: profile.id,
    profiles: catalog.profiles.map(entry => entry.id === profile.id ? { ...entry, config } : entry) });
  return config;
}
