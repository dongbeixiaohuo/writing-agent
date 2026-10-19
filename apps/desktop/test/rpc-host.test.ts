import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  UI_BRIDGE_PROTOCOL_VERSION,
  type ClientBridge,
} from "../../../packages/client-bridge/src/protocol.js";
import { dispatchDesktopRpc, safeDesktopFailure } from "../src/rpc-host.js";
import type { DesktopHostApi } from '../../../packages/client-bridge/src/desktop-bridge.js';
import { commandErrorMessage } from '../../../packages/ui/src/shell/onboarding.js';

test('publication preload preserves safe error codes in standard Error.message across contextBridge', async () => {
  const output = buildSync({ entryPoints: ['apps/desktop/src/preload.ts'], bundle: true, platform: 'node',
    format: 'cjs', external: ['electron'], write: false, logLevel: 'silent' }).outputFiles[0]!.text;
  let api: DesktopHostApi | undefined;
  let code = 'EXPORT_WRITING_ACTIVE';
  const electron = {
    contextBridge: { exposeInMainWorld: (_name: string, value: DesktopHostApi) => { api = value; } },
    ipcRenderer: { invoke: async () => safeDesktopFailure(new Error(code)), on: () => {}, removeListener: () => {} },
  };
  runInNewContext(output, { require: (name: string) => {
    assert.equal(name, 'electron'); return electron;
  } });
  assert.ok(api);
  for (code of ['EXPORT_WRITING_ACTIVE', 'FACT_GATE_NOT_PASSED', 'EXPORT_SELECTION_CHANGED', 'EXPORT_SAVE_FAILED']) {
    // Electron copies standard Error fields but not custom properties such as code.
    await assert.rejects(api.savePublicationAs({ projectId: 'p', bodyVersionId: 'b', format: 'html', layoutPreset: 'editorial' }),
      (error: Error) => error.message === code);
  }
  code = 'EXPORT_RECEIPT_NOT_FOUND';
  await assert.rejects(api.revealPublication('missing'), (error: Error) => error.message === code);
});

test('real Electron contextBridge preserves publication errors without relying on custom code properties',
  { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(join(tmpdir(), 'wa-publication-preload-'));
    try {
      const preload = join(root, 'preload.cjs');
      buildSync({ entryPoints: ['apps/desktop/src/preload.ts'], bundle: true, platform: 'node',
        format: 'cjs', external: ['electron'], outfile: preload, logLevel: 'silent' });
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      // Use a local executable directory like an installed app, not a synced
      // OneDrive checkout, while keeping all test data isolated in TEMP.
      const electronRoot = join(root, 'electron');
      cpSync(resolve('node_modules/electron/dist'), electronRoot, { recursive: true });
      const result = spawnSync(join(electronRoot, 'electron.exe'),
        [resolve('apps/desktop/test/fixtures/publication-preload.cjs'), preload, root],
        { env, windowsHide: true, encoding: 'utf8', timeout: 20000 });
      assert.equal(result.status, 0, result.stderr || String(result.error));
      assert.match(result.stdout, /PUBLICATION_CONTEXT_BRIDGE_PASS/u);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

test('confirmation and recovery failures keep their actionable code through desktop RPC and UI', async () => {
  for (const code of ['CHECKPOINT_DECISION_REQUIRED', 'INTENT_CONTEXT_STALE', 'INTENT_CONTEXT_INVALID',
    'RUN_NOT_RECOVERABLE', 'RUN_NOT_RESUMABLE', 'HANDOFF_CONTEXT_CHANGED', 'CONVERSATION_HANDOFF_FAILED', 'PUBLICATION_SELECTION_REQUIRED',
    'RUN_SCOPE_INVALID', 'FACT_INPUTS_INCOMPLETE', 'CHECKPOINT_FEEDBACK_NOT_ALLOWED']) {
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
    getRunTraceDetail: async input => ({ runId: input.runId, stepId: input.stepId, requestId: null, callId: null, provider: null, model: null, sections: [], notes: [] }),
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
