import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ToolRegistry,
  createToolPermissionGrant,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolPermissionGrant,
} from "../src/index.js";

const inspectDefinition: ToolDefinition<
  { materialId: string },
  { content: string }
> = {
  name: "inspect_material",
  version: "1.0.0",
  description: "Inspect one authorized material",
  inputSchema: {
    type: "object",
    properties: { materialId: { type: "string", minLength: 1 } },
    required: ["materialId"],
    additionalProperties: false,
  },
  effect: "read_only",
  permissions: ["material:read"],
  async validateTarget() {},
  async execute() {
    return { content: "authorized material" };
  },
};

function context(
  permissions: readonly string[],
  permissionGrant: ToolPermissionGrant = createToolPermissionGrant({
    projectId: "project-1",
    runId: "run-1",
    permissions,
  }),
): ToolExecutionContext {
  return {
    projectId: "project-1",
    runId: "run-1",
    operationId: "operation-1",
    abortSignal: new AbortController().signal,
    expectedBodyVersionId: null,
    permissionGrant,
  };
}

describe("tool registry public execution seam", () => {
  it("binds each model schema to a stable tool version and hash", () => {
    const registry = ToolRegistry.create([inspectDefinition]);

    assert.deepEqual(registry.schemaSnapshots(), [
      {
        name: "inspect_material",
        version: "1.0.0",
        description: "Inspect one authorized material",
        inputSchema: inspectDefinition.inputSchema,
        schemaHash:
          "d59e78fec0e33c012a12cd14a1c7ac6ad250b1aea234310b8c05678caca3fda1",
      },
    ]);
    assert.equal(Object.isFrozen(registry.schemaSnapshots()[0]), true);
  });

  it("validates arguments before permission and target checks", async () => {
    const phases: string[] = [];
    const definition: ToolDefinition<
      { materialId: string },
      { content: string }
    > = {
      ...inspectDefinition,
      async validateTarget() {
        phases.push("target");
      },
      async execute() {
        phases.push("execute");
        return { content: "authorized material" };
      },
    };
    const registry = ToolRegistry.create([definition]);

    const invalid = await registry.execute(
      {
        id: "call-invalid",
        name: "inspect_material",
        arguments: {},
        rawArguments: "{}",
      },
      context([]),
    );
    assert.equal(invalid.ok, false);
    if (!invalid.ok) assert.equal(invalid.error.code, "TOOL_INPUT_INVALID");
    assert.deepEqual(phases, []);

    const denied = await registry.execute(
      {
        id: "call-denied",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      context([]),
    );
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.error.code, "TOOL_PERMISSION_DENIED");
    assert.deepEqual(phases, []);

    const allowed = await registry.execute(
      {
        id: "call-allowed",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      context(["material:read"]),
    );
    assert.deepEqual(phases, ["target", "execute"]);
    assert.equal(allowed.ok, true);
    if (allowed.ok) {
      assert.deepEqual(allowed.result, { content: "authorized material" });
      assert.equal(allowed.toolVersion, "1.0.0");
      assert.equal(allowed.effect, "read_only");
    }
  });

  it("rejects permission objects that were not issued by the application", async () => {
    const forgedGrant = {
      projectId: "project-1",
      runId: "run-1",
      permissions: ["material:read"],
    } as unknown as ToolPermissionGrant;
    const registry = ToolRegistry.create([inspectDefinition]);

    const result = await registry.execute(
      {
        id: "call-forged",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      context(["material:read"], forgedGrant),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TOOL_PERMISSION_DENIED");
  });

  it("binds grants to one project and run, not only a permission string", async () => {
    const registry = ToolRegistry.create([inspectDefinition]);
    const wrongScope = createToolPermissionGrant({
      projectId: "project-2",
      runId: "run-2",
      permissions: ["material:read"],
    });
    const result = await registry.execute(
      {
        id: "call-wrong-scope",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      context(["material:read"], wrongScope),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TOOL_PERMISSION_DENIED");
  });

  it("rejects raw/parsed argument disagreement before a tool can run", async () => {
    let executed = false;
    const registry = ToolRegistry.create([
      {
        ...inspectDefinition,
        async execute() {
          executed = true;
          return { content: "must not run" };
        },
      },
    ]);
    const result = await registry.execute(
      {
        id: "call-argument-mismatch",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-2"}',
      },
      context(["material:read"]),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TOOL_INPUT_INVALID");
    assert.equal(executed, false);
  });

  it("drops a completed result when cancellation arrives during execution", async () => {
    const controller = new AbortController();
    let release: ((value: { content: string }) => void) | undefined;
    const registry = ToolRegistry.create([
      {
        ...inspectDefinition,
        async execute() {
          return new Promise<{ content: string }>((resolve) => {
            release = resolve;
          });
        },
      },
    ]);
    const pending = registry.execute(
      {
        id: "call-cancelled",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      {
        ...context(["material:read"]),
        abortSignal: controller.signal,
      },
    );
    await Promise.resolve();
    controller.abort("user stopped");
    assert.notEqual(release, undefined);
    release?.({ content: "late result" });
    const result = await pending;

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "ABORTED");
    assert.equal(JSON.stringify(result).includes("late result"), false);
  });

  it("rejects oversized tool output instead of injecting an unbounded result", async () => {
    const registry = ToolRegistry.create(
      [
        {
          ...inspectDefinition,
          async execute() {
            return { content: "0123456789abcdef" };
          },
        },
      ],
      { maxOutputBytes: 10 },
    );
    const result = await registry.execute(
      {
        id: "call-output-limit",
        name: "inspect_material",
        arguments: { materialId: "material-1" },
        rawArguments: '{"materialId":"material-1"}',
      },
      context(["material:read"]),
    );

    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "TOOL_OUTPUT_TOO_LARGE");
  });

  it("fails startup on duplicate names and exposes no hot registration API", () => {
    assert.throws(
      () => ToolRegistry.create([inspectDefinition, inspectDefinition]),
      /Duplicate tool name: inspect_material/,
    );
    const registry = ToolRegistry.create([inspectDefinition]);
    assert.equal("register" in registry, false);
    assert.equal("install" in registry, false);
  });
});
