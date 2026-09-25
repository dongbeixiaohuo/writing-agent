import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CredentialBroker } from "../../credentials/src/index.js";
import {
  createConfiguredProvider,
  parseProviderConfig,
} from "../src/index.js";

describe("provider configuration boundary", () => {
  it("normalizes an Anthropic SDK-style base URL to the direct Messages API base", () => {
    const config = parseProviderConfig({
      schemaVersion: 2,
      kind: "anthropic_compatible",
      providerId: "minimax-cn",
      baseURL: "https://api.minimaxi.com/anthropic",
      credentialRef: "managed:minimax-primary",
      model: "MiniMax-M3",
      tools: "supported",
      usage: "reported",
    });

    assert.equal(config.baseURL, "https://api.minimaxi.com/anthropic/v1");
  });

  it("normalizes the legacy OpenAI environment reference without accepting a key", () => {
    const config = parseProviderConfig({
      schemaVersion: 1,
      kind: "openai_compatible",
      providerId: "legacy-openai",
      baseURL: "https://api.example.invalid/v1",
      credentialEnv: "WRITING_AGENT_API_KEY",
      model: "tool-model",
      toolCallingVerified: true,
      usage: "unknown",
    });

    assert.deepEqual(config, {
      schemaVersion: 2,
      kind: "openai_compatible",
      providerId: "legacy-openai",
      baseURL: "https://api.example.invalid/v1",
      credentialRef: "env:WRITING_AGENT_API_KEY",
      model: "tool-model",
      tools: "supported",
      usage: "unknown",
    });
    assert.equal(JSON.stringify(config).includes("sk-"), false);
  });

  it("creates either protocol from a managed credential reference", () => {
    const broker = new CredentialBroker({ environment: {} });
    const openai = createConfiguredProvider(
      parseProviderConfig({
        schemaVersion: 2,
        kind: "openai_compatible",
        providerId: "openai-fixture",
        baseURL: "https://openai.example.invalid/v1",
        credentialRef: "managed:openai-primary",
        model: "openai-tool-model",
        tools: "supported",
        usage: "reported",
      }),
      broker,
    );
    const anthropic = createConfiguredProvider(
      parseProviderConfig({
        schemaVersion: 2,
        kind: "anthropic_compatible",
        providerId: "anthropic-fixture",
        baseURL: "https://anthropic.example.invalid/v1",
        credentialRef: "managed:anthropic-primary",
        model: "anthropic-tool-model",
        tools: "supported",
        usage: "reported",
        anthropicVersion: "2023-06-01",
        authHeader: "x-api-key",
        defaultMaxOutputTokens: 2048,
      }),
      broker,
    );

    assert.equal(openai.capabilitiesFor("openai-tool-model").protocol, "openai-chat-completions");
    assert.equal(anthropic.capabilitiesFor("anthropic-tool-model").protocol, "anthropic-messages");
    assert.equal(openai.capabilitiesFor("unknown-model").tools, "unknown");
    assert.equal(anthropic.capabilitiesFor("unknown-model").tools, "unknown");
  });

  it("rejects plaintext, malformed and ambiguous credential references", () => {
    const base = {
      schemaVersion: 2,
      kind: "anthropic_compatible",
      providerId: "unsafe",
      baseURL: "https://api.example.invalid/v1",
      model: "model",
      tools: "supported",
      usage: "unknown",
    } as const;
    for (const credentialRef of [
      "sk-plain-text-key",
      "WRITING_AGENT_API_KEY",
      "managed:../escape",
      "env:lowercase",
    ]) {
      assert.throws(
        () => parseProviderConfig({ ...base, credentialRef }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === "ProviderConfigError" &&
          !String(error).includes(credentialRef),
      );
    }
  });
});
