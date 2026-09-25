import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BundledModuleHost,
  ModuleHostError,
  type RuntimeModule,
} from "../src/index.js";

describe("bundled runtime module lifecycle", () => {
  it("starts in dependency order and disposes once in reverse order", async () => {
    const events: string[] = [];
    let lateRegister: (() => void) | undefined;
    const storage: RuntimeModule = {
      id: "storage",
      version: "1.0.0",
      requires: [],
      async activate(context) {
        events.push("start:storage");
        context.registerService("storage", { name: "workspace-storage" });
        return async () => {
          events.push("stop:storage");
        };
      },
    };
    const tools: RuntimeModule = {
      id: "tools",
      version: "1.0.0",
      requires: ["storage"],
      async activate(context) {
        events.push(`start:tools:${context.getService<{ name: string }>("storage").name}`);
        context.registerService("tools", { count: 3 });
        lateRegister = () => {
          context.registerService("late", { forbidden: true });
        };
        return async () => {
          events.push("stop:tools");
        };
      },
    };
    const host = BundledModuleHost.create([tools, storage]);

    await host.start();
    assert.deepEqual(events, [
      "start:storage",
      "start:tools:workspace-storage",
    ]);
    assert.deepEqual(host.getService("tools"), { count: 3 });
    assert.equal("install" in host, false);
    assert.equal("addModule" in host, false);
    if (lateRegister === undefined) throw new Error("late registration fixture missing");
    assert.throws(lateRegister, (error: unknown) =>
      error instanceof ModuleHostError && error.code === "MODULE_CONTEXT_CLOSED",
    );

    await host.stop();
    await host.stop();
    assert.deepEqual(events, [
      "start:storage",
      "start:tools:workspace-storage",
      "stop:tools",
      "stop:storage",
    ]);
    assert.throws(() => host.getService("tools"), /Service is not available/);
  });

  it("rejects missing, duplicate and cyclic module dependencies before activation", () => {
    const activated: string[] = [];
    const module = (id: string, requires: readonly string[]): RuntimeModule => ({
      id,
      version: "1.0.0",
      requires,
      async activate() {
        activated.push(id);
        return async () => {};
      },
    });

    assert.throws(
      () => BundledModuleHost.create([module("tools", ["storage"])]),
      (error: unknown) =>
        error instanceof ModuleHostError && error.code === "MODULE_DEPENDENCY_MISSING",
    );
    assert.throws(
      () => BundledModuleHost.create([module("tools", []), module("tools", [])]),
      (error: unknown) =>
        error instanceof ModuleHostError && error.code === "MODULE_DUPLICATE",
    );
    assert.throws(
      () =>
        BundledModuleHost.create([
          module("alpha", ["beta"]),
          module("beta", ["alpha"]),
        ]),
      (error: unknown) =>
        error instanceof ModuleHostError && error.code === "MODULE_DEPENDENCY_CYCLE",
    );
    assert.deepEqual(activated, []);
  });

  it("removes partial services and reverses prior modules after activation failure", async () => {
    const events: string[] = [];
    const foundation: RuntimeModule = {
      id: "foundation",
      version: "1.0.0",
      requires: [],
      async activate(context) {
        events.push("start:foundation");
        context.registerService("foundation", { ready: true });
        return async () => {
          events.push("stop:foundation");
        };
      },
    };
    const failing: RuntimeModule = {
      id: "failing",
      version: "1.0.0",
      requires: ["foundation"],
      async activate(context) {
        events.push("start:failing");
        context.registerService("partial", { secret: "must disappear" });
        throw new Error("activation detail must not escape");
      },
    };
    const host = BundledModuleHost.create([foundation, failing]);

    await assert.rejects(
      () => host.start(),
      (error: unknown) => {
        assert.equal(error instanceof ModuleHostError, true);
        if (!(error instanceof ModuleHostError)) return false;
        assert.equal(error.code, "MODULE_ACTIVATION_FAILED");
        assert.equal(String(error).includes("activation detail"), false);
        return true;
      },
    );
    assert.deepEqual(events, [
      "start:foundation",
      "start:failing",
      "stop:foundation",
    ]);
    assert.throws(() => host.getService("partial"), /Service is not available/);
    assert.throws(() => host.getService("foundation"), /Service is not available/);
    await host.stop();
    assert.deepEqual(events, [
      "start:foundation",
      "start:failing",
      "stop:foundation",
    ]);
  });

  it("treats duplicate service registration as activation failure", async () => {
    const events: string[] = [];
    const first: RuntimeModule = {
      id: "first",
      version: "1.0.0",
      requires: [],
      async activate(context) {
        context.registerService("shared", { owner: "first" });
        return async () => {
          events.push("stop:first");
        };
      },
    };
    const second: RuntimeModule = {
      id: "second",
      version: "1.0.0",
      requires: ["first"],
      async activate(context) {
        context.registerService("shared", { owner: "second" });
        return async () => {};
      },
    };
    const host = BundledModuleHost.create([first, second]);

    await assert.rejects(() => host.start(), {
      name: "ModuleHostError",
      code: "MODULE_ACTIVATION_FAILED",
    });
    assert.deepEqual(events, ["stop:first"]);
  });
});
