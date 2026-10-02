import assert from "node:assert/strict";
import { test } from "node:test";

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type ClientBridge,
} from "../../../packages/client-bridge/src/protocol.js";
import { dispatchDesktopRpc } from "../src/rpc-host.js";
import { commandErrorMessage } from '../../../packages/ui/src/shell/onboarding.js';

test('confirmation and recovery failures keep their actionable code through desktop RPC and UI', async () => {
  for (const code of ['CHECKPOINT_DECISION_REQUIRED', 'INTENT_CONTEXT_STALE', 'INTENT_CONTEXT_INVALID',
    'RUN_NOT_RECOVERABLE', 'RUN_NOT_RESUMABLE', 'HANDOFF_CONTEXT_CHANGED', 'CONVERSATION_HANDOFF_FAILED', 'PUBLICATION_SELECTION_REQUIRED']) {
    const bridge = fakeBridge();
    bridge.resumeRun = async () => { throw Object.assign(new Error('private diagnostic'), { code }); };
    const result = await dispatchDesktopRpc(bridge, { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'resumeRun', args: ['r', 'resume'] });
    assert.equal(result.ok, false);
    if (result.ok) continue;
    assert.equal(result.error.code, code);
    assert.doesNotMatch(result.error.message, /private diagnostic/);
    assert.notEqual(commandErrorMessage({ code }, 'unmapped'), 'unmapped');
  }
});

function fakeBridge(): ClientBridge {
  const snapshot = {
    revision: 1,
    generation: 1,
    workspaceId: "rpc-workspace",
  } as ReturnType<ClientBridge["getSnapshot"]>;
  return {
    handshake: async () => ({
      protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
      clientBuild: "rpc-test",
      runtimeBuild: "rpc-test",
      capabilities: [],
      mock: false,
      persistsUserProjects: true,
      workspaceId: "rpc-workspace",
    }),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    selectProject: async () => undefined,
    selectSession: async () => undefined,
    updateSettings: async () => undefined,
    createProject: async () => ({ projectId: "project-1" }),
    updateBrief: async () => undefined,
    confirmBrief: async () => undefined,
    sendMessage: async () => ({ runId: "run-1" }),
    startConversation: async () => ({ runId: "intake-1" }),
    confirmConversation: async () => ({ runId: "confirmed-1" }),
    runFactCheck: async () => ({ runId: "fact-run-1" }),
    cancelRun: async () => undefined,
    resumeRun: async () => undefined,
    proposeRevision: async () => ({ proposalId: "proposal-1" }),
    acceptRevision: async () => ({ versionId: "version-1", status: "created" }),
    rejectRevision: async () => undefined,
    saveBody: async () => ({ versionId: "version-1", status: "created" }),
    setBlockLock: async () => undefined,
    rollbackBody: async () => ({ versionId: "version-2" }),
    saveWorkingCopy: async () => ({}) as never,
    exportPublication: async () => ({}) as never,
    refresh: async () => undefined,
    dispose: () => undefined,
  };
}

test("desktop RPC host dispatches only the fixed protocol allowlist", async () => {
  const bridge = fakeBridge();
  const sent = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
    method: "sendMessage",
    args: ["开始", { operationId: "operation-1" }],
  });
  assert.equal(sent.ok, true);
  if (sent.ok) assert.deepEqual(sent.result, { runId: "run-1" });
  for (const [method, value, runId] of [
    ['startConversation', '我还没想好，你帮我想想', 'intake-1'],
    ['confirmConversation', 'proposal-1', 'confirmed-1'],
  ] as const) {
    const response = await dispatchDesktopRpc(bridge, { protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method,
      args: [value, { operationId: `operation-${method}` }] });
    assert.equal(response.ok, true);
    if (response.ok) assert.deepEqual(response.result, { runId });
  }

  const wrongVersion = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION - 1 as typeof UI_BRIDGE_PROTOCOL_VERSION,
    method: "refresh",
    args: [],
  });
  assert.equal(wrongVersion.ok, false);
  if (!wrongVersion.ok) assert.equal(wrongVersion.error.code, "PROTOCOL_VERSION_MISMATCH");

  const arbitrary = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
    method: "constructor" as "refresh",
    args: [],
  });
  assert.equal(arbitrary.ok, false);
  if (!arbitrary.ok) assert.equal(arbitrary.error.code, "DESKTOP_METHOD_NOT_ALLOWED");
});

test("desktop RPC errors never expose raw exception messages or paths", async () => {
  const bridge = fakeBridge();
  bridge.sendMessage = async () => {
    throw new Error("PRIVATE-MATERIAL at C:\\Users\\person\\secret.md");
  };
  const failed = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
    method: "sendMessage",
    args: ["开始", { operationId: "operation-1" }],
  });
  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes("PRIVATE-MATERIAL"), false);
  assert.equal(JSON.stringify(failed).includes("C:\\Users"), false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "DESKTOP_COMMAND_FAILED");
    assert.equal(failed.error.message, "Desktop command failed");
  }
});

test("desktop RPC preserves allowlisted writing error codes with safe messages", async () => {
  const bridge = fakeBridge();
  bridge.sendMessage = async () => {
    throw Object.assign(new Error("internal detail that must stay private"), {
      code: "MODEL_PROVIDER_REQUIRED",
    });
  };
  const failed = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION,
    method: "sendMessage",
    args: ["开始", { operationId: "operation-1" }],
  });

  assert.equal(failed.ok, false);
  assert.equal(JSON.stringify(failed).includes("internal detail"), false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "MODEL_PROVIDER_REQUIRED");
    assert.equal(failed.error.message, "A model provider must be configured before writing");
  }
});

test('desktop distinguishes an empty submission from unknown transport failure', async () => {
  const bridge = fakeBridge();
  bridge.resumeRun = async () => { throw new Error('EMPTY_MESSAGE'); };
  const failed = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'resumeRun', args: ['run-1', 'resume'],
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, 'EMPTY_MESSAGE');
});

test('desktop preserves missing-input guidance without exposing private details', async () => {
  const bridge = fakeBridge();
  bridge.resumeRun = async () => {
    throw Object.assign(new Error('PRIVATE MATERIAL CONTENT'), { code: 'WRITING_INPUT_ANSWER_REQUIRED' });
  };
  const failed = await dispatchDesktopRpc(bridge, {
    protocolVersion: UI_BRIDGE_PROTOCOL_VERSION, method: 'resumeRun', args: ['run-1', 'resume'],
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error.code, 'WRITING_INPUT_ANSWER_REQUIRED');
  assert.equal(JSON.stringify(failed).includes('PRIVATE MATERIAL CONTENT'), false);
});
