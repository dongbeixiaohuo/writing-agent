import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CredentialBroker,
  CredentialStoreError,
  WindowsCredentialManagerBackend,
  type CredentialCommandRequest,
  type CredentialCommandResponse,
  type SystemCredentialBackend,
} from "../src/index.js";

const fakeSecret = "sk-test-not-a-real-key";

class MemorySystemBackend implements SystemCredentialBackend {
  readonly values = new Map<string, string>();

  constructor(
    private readonly available: boolean,
    private readonly failWrites = false,
  ) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async read(id: string): Promise<string | null> {
    return this.values.get(id) ?? null;
  }

  async write(id: string, secret: string): Promise<void> {
    if (this.failWrites) {
      throw new Error(`backend exploded with ${secret} at C:\\private`);
    }
    this.values.set(id, secret);
  }

  async delete(id: string): Promise<void> {
    this.values.delete(id);
  }
}

class CountingSystemBackend implements SystemCredentialBackend {
  readonly values = new Map<string, string>();
  probes = 0;
  reads = 0;

  async isAvailable(): Promise<boolean> { this.probes += 1; return true; }
  async read(id: string): Promise<string | null> { this.reads += 1; return this.values.get(id) ?? null; }
  async write(id: string, secret: string): Promise<void> { this.values.set(id, secret); }
  async delete(id: string): Promise<void> { this.values.delete(id); }
}

describe("CredentialBroker", () => {
  it("memoizes availability and collapses repeated inspects, invalidating on save and delete", async () => {
    const backend = new CountingSystemBackend();
    const broker = new CredentialBroker({ systemBackend: backend, environment: {} });

    await broker.saveManaged("cached-one", fakeSecret, "system");
    const reference = "managed:cached-one";
    const first = await broker.inspect(reference);
    const afterFirst = { probes: backend.probes, reads: backend.reads };
    for (let n = 0; n < 5; n++) {
      assert.deepEqual(await broker.inspect(reference), first);
    }
    assert.deepEqual(
      { probes: backend.probes, reads: backend.reads },
      afterFirst,
      "repeated inspects within the TTL must not spawn new backend work",
    );

    await broker.saveManaged("cached-one", `${fakeSecret}-rotated`, "system");
    assert.equal(backend.values.get("cached-one"), `${fakeSecret}-rotated`);
    const readsAfterSave = backend.reads;
    assert.deepEqual((await broker.inspect(reference)).configured, true);
    assert.equal(backend.reads, readsAfterSave + 1, "a save invalidates the cached entry exactly once");

    await broker.deleteManaged("cached-one");
    const readsAfterDelete = backend.reads;
    assert.deepEqual((await broker.inspect(reference)).configured, false);
    assert.equal(backend.reads, readsAfterDelete + 1, "a delete also invalidates the cached entry");

    assert.equal(backend.probes, 1, "backend availability is probed once per broker, not per operation");
  });

  it("stores managed credentials in the system backend and exposes metadata only", async () => {
    const backend = new MemorySystemBackend(true);
    const broker = new CredentialBroker({
      systemBackend: backend,
      environment: {},
    });

    const saved = await broker.saveManaged(
      "primary-anthropic",
      fakeSecret,
      "system",
    );

    assert.deepEqual(saved, {
      reference: "managed:primary-anthropic",
      configured: true,
      persistence: "system",
      fallbackReason: null,
    });
    assert.equal(
      await broker.resolve("managed:primary-anthropic"),
      fakeSecret,
    );
    assert.equal(JSON.stringify(saved).includes(fakeSecret), false);
    assert.deepEqual(await broker.inspect("managed:primary-anthropic"), saved);

    await broker.deleteManaged("primary-anthropic");
    assert.equal(await broker.resolve("managed:primary-anthropic"), undefined);
    assert.deepEqual(await broker.inspect("managed:primary-anthropic"), {
      reference: "managed:primary-anthropic",
      configured: false,
      persistence: "missing",
      fallbackReason: null,
    });
  });

  it("falls back to process memory only when secure persistence is unavailable", async () => {
    const broker = new CredentialBroker({
      systemBackend: new MemorySystemBackend(false),
      environment: { TEMP_PROVIDER_KEY: fakeSecret },
    });

    const saved = await broker.saveManaged(
      "session-profile",
      fakeSecret,
      "system",
    );
    assert.deepEqual(saved, {
      reference: "managed:session-profile",
      configured: true,
      persistence: "session",
      fallbackReason: "system_unavailable",
    });
    assert.equal(await broker.resolve("managed:session-profile"), fakeSecret);
    assert.equal(await broker.resolve("env:TEMP_PROVIDER_KEY"), fakeSecret);
    broker.clearSession();
    assert.equal(await broker.resolve("managed:session-profile"), undefined);
    assert.equal(JSON.stringify(broker).includes(fakeSecret), false);
  });

  it("sanitizes system-store failures before returning a session fallback", async () => {
    const broker = new CredentialBroker({
      systemBackend: new MemorySystemBackend(true, true),
      environment: {},
    });
    const result = await broker.saveManaged("safe-profile", fakeSecret, "system");
    assert.equal(result.persistence, "session");
    assert.equal(result.fallbackReason, "system_write_failed");
    assert.equal(JSON.stringify(result).includes(fakeSecret), false);
    assert.equal(JSON.stringify(result).includes("C:\\private"), false);
  });
});

describe("WindowsCredentialManagerBackend", () => {
  it("uses an application-scoped target and base64 transport without exposing secrets", async () => {
    const requests: CredentialCommandRequest[] = [];
    const values = new Map<string, string>();
    const backend = new WindowsCredentialManagerBackend({
      platform: "win32",
      invoke: async (
        request: CredentialCommandRequest,
      ): Promise<CredentialCommandResponse> => {
        requests.push(request);
        if (request.operation === "probe") return { ok: true };
        if (request.operation === "write") {
          assert.notEqual(request.secretBase64, undefined);
          values.set(request.target, request.secretBase64 ?? "");
          return { ok: true };
        }
        if (request.operation === "read") {
          const secretBase64 = values.get(request.target);
          return secretBase64 === undefined
            ? { ok: true, found: false }
            : { ok: true, found: true, secretBase64 };
        }
        values.delete(request.target);
        return { ok: true };
      },
    });

    assert.equal(await backend.isAvailable(), true);
    await backend.write("profile_1", fakeSecret);
    assert.equal(await backend.read("profile_1"), fakeSecret);
    await backend.delete("profile_1");
    assert.equal(await backend.read("profile_1"), null);

    assert.equal(
      requests.every(
        (request) =>
          request.operation === "probe" ||
          request.target === "WritingAgent/1.0/profile_1",
      ),
      true,
    );
    assert.equal(JSON.stringify(requests).includes(fakeSecret), false);
  });

  it("rejects invalid identifiers and never includes native error details", async () => {
    const backend = new WindowsCredentialManagerBackend({
      platform: "win32",
      invoke: async () => ({ ok: false, errorCode: 1312 }),
    });

    await assert.rejects(
      () => backend.write("../escape", fakeSecret),
      (error: unknown) =>
        error instanceof CredentialStoreError &&
        error.code === "CREDENTIAL_ID_INVALID" &&
        !String(error).includes(fakeSecret),
    );
    await assert.rejects(
      () => backend.read("profile"),
      (error: unknown) =>
        error instanceof CredentialStoreError &&
        error.code === "CREDENTIAL_STORE_UNAVAILABLE" &&
        !String(error).includes("1312"),
    );
  });
});
