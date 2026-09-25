import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CredentialBroker,
  type SystemCredentialBackend,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  loadDesktopProviderProfile,
  parseDesktopProviderProfileInput,
  saveDesktopProviderProfile,
} from "../src/provider-profile.js";

class MemoryCredentials implements SystemCredentialBackend {
  readonly values = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async read(id: string): Promise<string | null> { return this.values.get(id) ?? null; }
  async write(id: string, secret: string): Promise<void> { this.values.set(id, secret); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

test("desktop provider profile keeps API keys out of JSON and returns only credential metadata", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-provider-profile-"));
  const path = join(root, "provider.json");
  const backend = new MemoryCredentials();
  const broker = new CredentialBroker({ systemBackend: backend, environment: {} });
  const secret = "sk-desktop-not-real";
  try {
    const saved = await saveDesktopProviderProfile(path, broker, {
      kind: "openai_compatible",
      providerId: "example-provider",
      baseURL: "https://api.example.test/v1",
      model: "example-model",
      tools: "supported",
      usage: "reported",
      apiKey: secret,
      persistence: "system",
    });
    assert.equal(saved.config.credentialRef, "managed:desktop-primary");
    assert.equal(saved.credential.configured, true);
    assert.equal(saved.credential.persistence, "system");
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(readFileSync(path, "utf8").includes(secret), false);
    assert.equal(await broker.resolve("managed:desktop-primary"), secret);

    const loaded = loadDesktopProviderProfile(path);
    assert.equal(loaded?.providerId, "example-provider");
    assert.equal(loaded?.model, "example-model");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("desktop provider input is strict runtime data and never echoes a submitted key", () => {
  const secret = "sk-private-malformed";
  assert.throws(
    () => parseDesktopProviderProfileInput({
      kind: "openai_compatible",
      providerId: "provider",
      baseURL: "https://api.example.test/v1",
      model: "model",
      tools: "supported",
      usage: "reported",
      apiKey: secret,
      persistence: "system",
      unexpected: true,
    }),
    (error: unknown) => {
      assert.equal(error instanceof Error, true);
      assert.equal(String(error).includes(secret), false);
      assert.equal((error as { code?: string }).code, "DESKTOP_PROVIDER_INPUT_INVALID");
      return true;
    },
  );
});

test("resaving the same Anthropic endpoint preserves legacy transport options omitted by the UI", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-provider-preserve-"));
  const path = join(root, "provider.json");
  const broker = new CredentialBroker({ systemBackend: new MemoryCredentials(), environment: {} });
  const input = {
    kind: "anthropic_compatible" as const, providerId: "legacy-gateway",
    baseURL: "https://gateway.example.test/anthropic", model: "old-model",
    tools: "supported" as const, usage: "reported" as const,
    apiKey: "not-real-old-key", persistence: "system" as const,
  };
  await saveDesktopProviderProfile(path, broker, { ...input,
    authHeader: "authorization", anthropicVersion: "2023-06-01", defaultMaxOutputTokens: 8192,
  });
  const saved = await saveDesktopProviderProfile(path, broker, parseDesktopProviderProfileInput({
    ...input, baseURL: "https://gateway.example.test/anthropic/v1/",
    providerId: "renamed-gateway", model: "new-model", apiKey: "not-real-new-key",
  }));
  assert.equal(saved.config.kind, "anthropic_compatible");
  if (saved.config.kind !== "anthropic_compatible") throw new Error("Unexpected protocol");
  assert.equal(saved.config.authHeader, "authorization");
  assert.equal(saved.config.anthropicVersion, "2023-06-01");
  assert.equal(saved.config.defaultMaxOutputTokens, 8192);
  assert.equal(saved.config.model, "new-model");
  assert.deepEqual(loadDesktopProviderProfile(path), saved.config);
  assert.equal(readFileSync(path, "utf8").includes("not-real-"), false);
  const explicit = await saveDesktopProviderProfile(path, broker, parseDesktopProviderProfileInput({
    ...input, authHeader: "x-api-key", defaultMaxOutputTokens: 4096,
  }));
  assert.equal(explicit.config.kind === "anthropic_compatible" && explicit.config.authHeader, "x-api-key");
  assert.equal(explicit.config.kind === "anthropic_compatible" && explicit.config.defaultMaxOutputTokens, 4096);
});

test("legacy Anthropic transport options never follow a different endpoint or protocol", async () => {
  for (const next of [
    { kind: "anthropic_compatible" as const, baseURL: "https://different.example.test/v1" },
    { kind: "openai_compatible" as const, baseURL: "https://gateway.example.test/v1" },
  ]) {
    const root = mkdtempSync(join(tmpdir(), "wa-provider-switch-"));
    const path = join(root, "provider.json");
    const broker = new CredentialBroker({ environment: {} });
    const input = {
      kind: "anthropic_compatible" as const, providerId: "gateway",
      baseURL: "https://gateway.example.test/v1", model: "model",
      tools: "supported" as const, usage: "reported" as const,
      apiKey: "not-real", persistence: "session" as const,
    };
    await saveDesktopProviderProfile(path, broker, { ...input,
      authHeader: "authorization", anthropicVersion: "2023-06-01", defaultMaxOutputTokens: 8192,
    });
    const saved = await saveDesktopProviderProfile(path, broker, { ...input, ...next });
    for (const name of ["authHeader", "anthropicVersion", "defaultMaxOutputTokens"]) {
      assert.equal(name in saved.config, false);
    }
  }
});

test("desktop provider profile rejects insecure HTTP unless explicitly allowed", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-provider-profile-reject-"));
  const path = join(root, "provider.json");
  const broker = new CredentialBroker({ environment: {} });
  try {
    await assert.rejects(
      saveDesktopProviderProfile(path, broker, {
        kind: "openai_compatible",
        providerId: "unsafe",
        baseURL: "http://api.example.test/v1",
        model: "example-model",
        tools: "supported",
        usage: "unknown",
        apiKey: "not-real",
        persistence: "session",
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "INSECURE_PROVIDER_URL_REJECTED");
        assert.equal((error as Error).message, "Provider URL must use HTTPS");
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
