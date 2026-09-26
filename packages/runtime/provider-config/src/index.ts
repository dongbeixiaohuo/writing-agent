import { z } from "zod";

import { AnthropicCompatibleProvider } from "../../../model-adapters/anthropic-compatible/src/index.js";
import { OpenAICompatibleProvider } from "../../../model-adapters/openai-compatible/src/index.js";
import { OpenAIResponsesProvider } from "../../../model-adapters/openai-responses/src/index.js";
import {
  CredentialBroker,
  WindowsCredentialManagerBackend,
} from "../../credentials/src/index.js";
import type { ModelProvider } from "../../llm/src/index.js";

const ProviderIdSchema = z.string().trim().min(1).max(128);
const ModelIdSchema = z.string().trim().min(1).max(256);
const CredentialReferenceSchema = z
  .string()
  .regex(
    /^(?:managed:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|env:[A-Z][A-Z0-9_]*)$/u,
  );
const ToolSupportSchema = z.enum(["supported", "unsupported"]);
const UsageSchema = z.enum(["reported", "unknown"]);

const LegacyOpenAIConfigSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("openai_compatible"),
    providerId: ProviderIdSchema,
    baseURL: z.string().url(),
    credentialEnv: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    model: ModelIdSchema,
    toolCallingVerified: z.literal(true),
    usage: UsageSchema,
    allowInsecureHttp: z.boolean().optional(),
  })
  .strict();

const OpenAIConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("openai_compatible"),
    providerId: ProviderIdSchema,
    baseURL: z.string().url(),
    credentialRef: CredentialReferenceSchema,
    model: ModelIdSchema,
    tools: ToolSupportSchema,
    usage: UsageSchema,
    allowInsecureHttp: z.boolean().optional(),
    // Vendor-specific extra request fields (e.g. DeepSeek thinking toggle).
    // Additive only; protocol fields always win on key collision.
    extraBody: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const AnthropicConfigSchema = z
  .object({
    schemaVersion: z.literal(2),
    kind: z.literal("anthropic_compatible"),
    providerId: ProviderIdSchema,
    baseURL: z.string().url(),
    credentialRef: CredentialReferenceSchema,
    model: ModelIdSchema,
    tools: ToolSupportSchema,
    usage: UsageSchema,
    allowInsecureHttp: z.boolean().optional(),
    anthropicVersion: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
    authHeader: z.enum(["x-api-key", "authorization"]).optional(),
    defaultMaxOutputTokens: z.number().int().positive().max(1_000_000).optional(),
  })
  .strict();

const ProviderConfigInputSchema = z.union([
  LegacyOpenAIConfigSchema,
  OpenAIConfigSchema,
  OpenAIConfigSchema.extend({ kind: z.literal('openai_responses') }),
  AnthropicConfigSchema,
]);

interface NormalizedProviderConfigBase {
  readonly schemaVersion: 2;
  readonly providerId: string;
  readonly baseURL: string;
  readonly credentialRef: string;
  readonly model: string;
  readonly tools: "supported" | "unsupported";
  readonly usage: "reported" | "unknown";
  readonly allowInsecureHttp?: boolean;
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

export interface OpenAIProviderConfig extends NormalizedProviderConfigBase {
  readonly kind: "openai_compatible";
}

export interface OpenAIResponsesConfig extends NormalizedProviderConfigBase {
  readonly kind: "openai_responses";
}

export interface AnthropicProviderConfig extends NormalizedProviderConfigBase {
  readonly kind: "anthropic_compatible";
  readonly anthropicVersion?: string;
  readonly authHeader?: "x-api-key" | "authorization";
  readonly defaultMaxOutputTokens?: number;
}

export type NormalizedProviderConfig =
  | OpenAIProviderConfig
  | OpenAIResponsesConfig
  | AnthropicProviderConfig;

export class ProviderConfigError extends Error {
  constructor(public readonly code: "PROVIDER_CONFIG_INVALID", message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

function normalizeAnthropicBaseURL(raw: string): string {
  const url = new URL(raw);
  const pathname = url.pathname.replace(/\/+$/u, "");
  if (pathname === "" || pathname.endsWith("/anthropic")) {
    url.pathname = `${pathname}/v1`;
  }
  return url.toString().replace(/\/$/u, "");
}

export function parseProviderConfig(input: unknown): NormalizedProviderConfig {
  const parsed = ProviderConfigInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ProviderConfigError(
      "PROVIDER_CONFIG_INVALID",
      "Provider configuration does not match a supported schema",
    );
  }
  const config = parsed.data;
  if (config.schemaVersion === 1) {
    return Object.freeze({
      schemaVersion: 2 as const,
      kind: "openai_compatible" as const,
      providerId: config.providerId,
      baseURL: config.baseURL,
      credentialRef: `env:${config.credentialEnv}`,
      model: config.model,
      tools: "supported" as const,
      usage: config.usage,
      ...(config.allowInsecureHttp === undefined
        ? {}
        : { allowInsecureHttp: config.allowInsecureHttp }),
    });
  }
  const common = {
    schemaVersion: 2 as const,
    providerId: config.providerId,
    baseURL: config.baseURL,
    credentialRef: config.credentialRef,
    model: config.model,
    tools: config.tools,
    usage: config.usage,
    ...(config.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: config.allowInsecureHttp }),
    ...(!('extraBody' in config) || config.extraBody === undefined
      ? {}
      : { extraBody: config.extraBody }),
  };
  if (config.kind === "openai_compatible" || config.kind === 'openai_responses') {
    return Object.freeze({ ...common, kind: config.kind });
  }
  return Object.freeze({
    ...common,
    kind: "anthropic_compatible" as const,
    baseURL: normalizeAnthropicBaseURL(config.baseURL),
    ...(config.anthropicVersion === undefined
      ? {}
      : { anthropicVersion: config.anthropicVersion }),
    ...(config.authHeader === undefined
      ? {}
      : { authHeader: config.authHeader }),
    ...(config.defaultMaxOutputTokens === undefined
      ? {}
      : { defaultMaxOutputTokens: config.defaultMaxOutputTokens }),
  });
}

export function createDefaultCredentialBroker(): CredentialBroker {
  return new CredentialBroker({
    systemBackend: new WindowsCredentialManagerBackend(),
    environment: process.env,
  });
}

export function createConfiguredProvider(
  config: NormalizedProviderConfig,
  credentials: CredentialBroker,
): ModelProvider {
  const common = {
    id: config.providerId,
    baseURL: config.baseURL,
    credentialRef: config.credentialRef,
    resolveCredential: async (reference: string) => credentials.resolve(reference),
    models: {
      [config.model]: {
        tools: config.tools,
        usage: config.usage,
      },
    },
    ...(config.allowInsecureHttp === undefined
      ? {}
      : { allowInsecureHttp: config.allowInsecureHttp }),
  };
  if (config.kind === "openai_compatible") {
    return new OpenAICompatibleProvider({
      ...common,
      ...(config.extraBody === undefined ? {} : { extraBody: config.extraBody }),
    });
  }
  if (config.kind === 'openai_responses') return new OpenAIResponsesProvider(common);
  return new AnthropicCompatibleProvider({
    ...common,
    ...(config.anthropicVersion === undefined
      ? {}
      : { anthropicVersion: config.anthropicVersion }),
    ...(config.authHeader === undefined
      ? {}
      : { authHeader: config.authHeader }),
    ...(config.defaultMaxOutputTokens === undefined
      ? {}
      : { defaultMaxOutputTokens: config.defaultMaxOutputTokens }),
  });
}
