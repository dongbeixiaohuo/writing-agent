import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CredentialBroker,
  type SystemCredentialBackend,
} from "../../../packages/runtime/credentials/src/index.js";
import {
  loadDesktopProviderProfile,
  loadDesktopProviderCatalog,
  selectDesktopProvider,
  parseDesktopProviderProfileInput,
  providerConfigForInput,
  saveDesktopProviderProfile,
} from "../src/provider-profile.js";
import { PROVIDER_PRESETS } from '../../../packages/client-bridge/src/provider-presets.js';

test('new Anthropic plan presets use source Bearer authentication only for their exact transport', () => {
  for (const id of ['zhipu-coding-anthropic', 'zai-coding-anthropic', 'qwen-cn-coding-anthropic']) {
    const preset = PROVIDER_PRESETS.find(p => p.id === id)!;
    const input = { kind: preset.kind, providerId: id, baseURL: preset.baseURL, model: 'account-model',
      tools: 'supported' as const, usage: 'reported' as const, apiKey: 'synthetic', persistence: 'session' as const };
    const current = providerConfigForInput(input);
    assert.equal(current.kind === 'anthropic_compatible' && current.authHeader, 'authorization');
    const changed = providerConfigForInput({ ...input, baseURL: 'https://different.example.test/v1' });
    assert.equal('authHeader' in changed, false);
    const legacy = providerConfigForInput({ ...input, authHeader: 'x-api-key' });
    const before = JSON.stringify(legacy);
    const edited = providerConfigForInput({ ...input, model: 'replacement' }, legacy);
    assert.equal(edited.kind === 'anthropic_compatible' && edited.authHeader, 'x-api-key');
    assert.equal(JSON.stringify(legacy), before);
  }
});

test('DeepSeek preset supplies thinking-disabled vendor fields and fills matching stored profiles at read time', () => {
  const preset = PROVIDER_PRESETS.find(p => p.id === 'cc-deepseek')!;
  assert.deepEqual(preset.extraBody, { thinking: { type: 'disabled' } });

  // New transport adopts the preset's reviewed adaptation.
  const input = { kind: preset.kind, providerId: preset.id, baseURL: preset.baseURL, model: 'deepseek-flash',
    tools: 'supported' as const, usage: 'reported' as const, apiKey: 'synthetic', persistence: 'session' as const };
  const current = providerConfigForInput(input);
  assert.deepEqual(current.extraBody, { thinking: { type: 'disabled' } });

  // A modified address no longer borrows the preset's vendor fields.
  const changed = providerConfigForInput({ ...input, baseURL: 'https://different.example.test/v1' });
  assert.equal('extraBody' in changed, false);

  // Re-saving the same transport preserves what the profile already carries.
  const edited = providerConfigForInput({ ...input, model: 'deepseek-v4-pro' }, current);
  assert.deepEqual(edited.extraBody, { thinking: { type: 'disabled' } });

  // Stored profiles saved before the adaptation are filled at read time only
  // when they still exactly match the preset; the file itself is not rewritten.
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-extrabody-'));
  const path = join(root, 'provider.json');
  try {
    const stored = { schemaVersion: 3, activeProfileId: 'p1', profiles: [
      { id: 'p1', displayName: 'DeepSeek', models: ['deepseek-flash'], config: {
        schemaVersion: 2, kind: 'openai_compatible', providerId: 'cc-deepseek',
        baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', tools: 'supported', usage: 'reported',
        credentialRef: 'managed:desktop-x' } },
      { id: 'p2', displayName: 'DeepSeek 自建', models: ['deepseek-flash'], config: {
        schemaVersion: 2, kind: 'openai_compatible', providerId: 'custom',
        baseURL: 'https://ds.example.test/v1', model: 'deepseek-flash', tools: 'supported', usage: 'reported',
        credentialRef: 'managed:desktop-y' } },
      { id: 'p3', displayName: 'DeepSeek Responses', models: ['deepseek-flash'], config: {
        schemaVersion: 2, kind: 'openai_responses', providerId: 'cc-deepseek',
        baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', tools: 'supported', usage: 'reported',
        credentialRef: 'managed:desktop-z' } },
      { id: 'p4', displayName: 'DeepSeek Anthropic', models: ['deepseek-flash'], config: {
        schemaVersion: 2, kind: 'anthropic_compatible', providerId: 'cc-deepseek',
        baseURL: 'https://api.deepseek.com/anthropic/v1', model: 'deepseek-flash', tools: 'supported', usage: 'reported',
        credentialRef: 'managed:desktop-w' } },
    ] };
    const original = JSON.stringify(stored);
    writeFileSync(path, original);
    const catalog = loadDesktopProviderCatalog(path);
    assert.deepEqual(catalog.profiles.find(p => p.id === 'p1')!.config.extraBody, { thinking: { type: 'disabled' } });
    assert.equal('extraBody' in catalog.profiles.find(p => p.id === 'p2')!.config, false);
    assert.deepEqual(catalog.profiles.find(p => p.id === 'p3')!.config.extraBody, { thinking: { type: 'disabled' } },
      'Responses-protocol DeepSeek profiles get the same thinking adaptation');
    const p4 = catalog.profiles.find(p => p.id === 'p4')!.config;
    assert.deepEqual(p4.kind === 'anthropic_compatible' && p4.extraBody, { thinking: { type: 'disabled' } },
      'Anthropic-protocol DeepSeek profiles at the official endpoint also get it');
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

class MemoryCredentials implements SystemCredentialBackend {
  readonly values = new Map<string, string>();
  async isAvailable(): Promise<boolean> { return true; }
  async read(id: string): Promise<string | null> { return this.values.get(id) ?? null; }
  async write(id: string, secret: string): Promise<void> { this.values.set(id, secret); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

test("legacy config is read without mutation and upgrades with its existing credential", async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-legacy-'));
  const path = join(root, 'provider.json');
  const broker = new CredentialBroker({ systemBackend: new MemoryCredentials(), environment: {} });
  try {
    await broker.saveManaged('desktop-primary', 'legacy-secret', 'system');
    const legacy = { schemaVersion: 2, kind: 'anthropic_compatible', providerId: 'minimax',
      baseURL: 'https://api.example.test/anthropic/v1', model: 'MiniMax-M3', tools: 'supported', usage: 'reported', credentialRef: 'managed:desktop-primary' };
    const original = JSON.stringify(legacy);
    writeFileSync(path, original);
    assert.equal(loadDesktopProviderCatalog(path).activeProfileId, 'legacy-primary');
    assert.equal(readFileSync(path, 'utf8'), original);
    const saved = await saveDesktopProviderProfile(path, broker, parseDesktopProviderProfileInput({
      profileId: 'legacy-primary', kind: legacy.kind, providerId: legacy.providerId,
      baseURL: legacy.baseURL, model: 'replacement', models: ['MiniMax-M3', 'replacement'],
      tools: legacy.tools, usage: legacy.usage, apiKey: '', persistence: 'system',
    }));
    assert.equal(saved.config.credentialRef, 'managed:desktop-primary');
    assert.equal(await broker.resolve(saved.config.credentialRef), 'legacy-secret');
    assert.equal(loadDesktopProviderCatalog(path).profiles.length, 1);
    assert.equal(loadDesktopProviderProfile(path)?.model, 'replacement');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("multiple providers retain independent keys and model selection across reloads", async () => {
  const root = mkdtempSync(join(tmpdir(), 'wa-provider-catalog-'));
  const path = join(root, 'provider.json');
  const broker = new CredentialBroker({ systemBackend: new MemoryCredentials(), environment: {} });
  const input = { profileId: null, kind: 'openai_compatible' as const, providerId: 'a', baseURL: 'https://a.example.test/v1',
    model: 'one', models: ['one', 'two'], tools: 'supported' as const, usage: 'reported' as const, apiKey: 'secret-a', persistence: 'system' as const };
  try {
    const a = await saveDesktopProviderProfile(path, broker, input);
    const aId = loadDesktopProviderCatalog(path).activeProfileId!;
    const b = await saveDesktopProviderProfile(path, broker, { ...input, providerId: 'b', baseURL: 'https://b.example.test/v1', apiKey: 'secret-b' });
    assert.notEqual(a.config.credentialRef, b.config.credentialRef);
    const bId = loadDesktopProviderCatalog(path).activeProfileId!;
    assert.equal(loadDesktopProviderCatalog(path).profiles.length, 2);
    selectDesktopProvider(path, aId, 'two');
    assert.equal(loadDesktopProviderProfile(path)?.model, 'two');
    assert.equal(await broker.resolve(loadDesktopProviderProfile(path)!.credentialRef), 'secret-a');
    selectDesktopProvider(path, bId, 'one');
    assert.equal(await broker.resolve(loadDesktopProviderProfile(path)!.credentialRef), 'secret-b');
    const before = readFileSync(path, 'utf8');
    assert.throws(() => selectDesktopProvider(path, aId, 'not-in-catalog'));
    assert.equal(readFileSync(path, 'utf8'), before);
    assert.equal(before.includes('secret-a') || before.includes('secret-b'), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("changing only the model reuses the saved key but a different endpoint cannot", async () => {
  const root = mkdtempSync(join(tmpdir(), "wa-provider-edit-"));
  const path = join(root, "provider.json");
  const broker = new CredentialBroker({ systemBackend: new MemoryCredentials(), environment: {} });
  const input = { kind: "anthropic_compatible" as const, providerId: "minimax", baseURL: "https://api.example.test/anthropic/v1",
    model: "model-one", tools: "supported" as const, usage: "reported" as const, apiKey: "test-secret", persistence: "system" as const };
  try {
    const first = await saveDesktopProviderProfile(path, broker, input);
    const updated = await saveDesktopProviderProfile(path, broker, parseDesktopProviderProfileInput({ ...input, model: "model-two", apiKey: "" }));
    assert.equal(updated.config.model, "model-two");
    assert.equal(updated.config.credentialRef, first.config.credentialRef);
    assert.equal(await broker.resolve(updated.config.credentialRef), "test-secret");
    await assert.rejects(saveDesktopProviderProfile(path, broker, { ...input, baseURL: "https://another.example.test/v1", apiKey: "" }),
      (error: unknown) => (error as { code?: string }).code === "PROVIDER_API_KEY_REQUIRED");
    assert.equal(loadDesktopProviderProfile(path)?.model, "model-two");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

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
    assert.match(saved.config.credentialRef, /^managed:desktop-/);
    assert.equal(saved.credential.configured, true);
    assert.equal(saved.credential.persistence, "system");
    assert.equal(JSON.stringify(saved).includes(secret), false);
    assert.equal(readFileSync(path, "utf8").includes(secret), false);
    assert.equal(await broker.resolve(saved.config.credentialRef), secret);

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
