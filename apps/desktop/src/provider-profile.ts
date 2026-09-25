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

const CREDENTIAL_ID = "desktop-primary";

const desktopProviderProfileSchema = z.object({
  kind: z.enum(["openai_compatible", "anthropic_compatible"]),
  providerId: z.string().trim().min(1).max(128),
  baseURL: z.string().trim().min(1).max(2048),
  model: z.string().trim().min(1).max(256),
  tools: z.enum(["supported", "unsupported"]),
  usage: z.enum(["reported", "unknown"]),
  apiKey: z.string().min(1).max(65536),
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
  const { anthropicVersion, authHeader, defaultMaxOutputTokens, ...base } = parsed.data;
  return {
    ...base,
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
  const filePath = resolve(filePathInput);
  try {
    const value = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    return parseProviderConfig(value);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) return null;
    throw providerProfileError(
      "DESKTOP_PROVIDER_PROFILE_INVALID",
      "Desktop provider profile is invalid",
    );
  }
}

export async function saveDesktopProviderProfile(
  filePathInput: string,
  credentials: CredentialBroker,
  input: DesktopProviderProfileInput,
): Promise<SavedDesktopProviderProfile> {
  assertTransport(input.baseURL, input.allowInsecureHttp === true);
  let config = parseProviderConfig({
    schemaVersion: 2,
    kind: input.kind,
    providerId: input.providerId,
    baseURL: input.baseURL,
    credentialRef: `managed:${CREDENTIAL_ID}`,
    model: input.model,
    tools: input.tools,
    usage: input.usage,
    ...(input.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: input.allowInsecureHttp }),
    ...(input.kind === "anthropic_compatible" && input.anthropicVersion !== undefined
      ? { anthropicVersion: input.anthropicVersion }
      : {}),
    ...(input.kind === "anthropic_compatible" && input.authHeader !== undefined
      ? { authHeader: input.authHeader }
      : {}),
    ...(input.kind === "anthropic_compatible" && input.defaultMaxOutputTokens !== undefined
      ? { defaultMaxOutputTokens: input.defaultMaxOutputTokens }
      : {}),
  });
  // The beginner form does not edit advanced wire options. Preserve those
  // already stored for this exact normalized endpoint, never across providers.
  if (config.kind === "anthropic_compatible") {
    const previous = loadDesktopProviderProfile(filePathInput);
    if (previous?.kind === "anthropic_compatible" && previous.baseURL === config.baseURL) {
      config = parseProviderConfig({
        anthropicVersion: previous.anthropicVersion,
        authHeader: previous.authHeader,
        defaultMaxOutputTokens: previous.defaultMaxOutputTokens,
        ...config,
      });
    }
  }
  const credential = await credentials.saveManaged(
    CREDENTIAL_ID,
    input.apiKey,
    input.persistence,
  );
  const filePath = resolve(filePathInput);
  mkdirSync(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    renameSync(temporaryPath, filePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return { config, credential };
}
