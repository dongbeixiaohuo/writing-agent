import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CredentialBroker,
  type SystemCredentialBackend,
} from "../../../packages/runtime/credentials/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import { runCli } from "../src/index.js";

describe("minimal runtime CLI", () => {
  it("imports a credential from an environment reference without putting it in output", async () => {
    const fakeCredential = "credential-import-fixture-not-a-real-key";
    class MemoryBackend implements SystemCredentialBackend {
      readonly values = new Map<string, string>();
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async read(id: string): Promise<string | null> {
        return this.values.get(id) ?? null;
      }
      async write(id: string, secret: string): Promise<void> {
        this.values.set(id, secret);
      }
      async delete(id: string): Promise<void> {
        this.values.delete(id);
      }
    }
    const backend = new MemoryBackend();
    const credentials = new CredentialBroker({
      systemBackend: backend,
      environment: { WA015_IMPORT_KEY: fakeCredential },
    });
    const stdout: string[] = [];
    const stderr: string[] = [];

    assert.equal(
      await runCli(
        [
          "credential",
          "set",
          "--id",
          "anthropic-primary",
          "--from-env",
          "WA015_IMPORT_KEY",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
        { credentials },
      ),
      0,
    );
    assert.deepEqual(stderr, []);
    assert.deepEqual(JSON.parse(stdout.join("\n")), {
      reference: "managed:anthropic-primary",
      configured: true,
      persistence: "system",
      fallbackReason: null,
    });
    assert.equal(backend.values.get("anthropic-primary"), fakeCredential);
    assert.equal(stdout.join("\n").includes(fakeCredential), false);

    stdout.length = 0;
    assert.equal(
      await runCli(
        ["credential", "delete", "--id", "anthropic-primary"],
        { stdout: (line) => stdout.push(line), stderr: () => undefined },
        { credentials },
      ),
      0,
    );
    assert.deepEqual(JSON.parse(stdout.join("\n")), {
      reference: "managed:anthropic-primary",
      deleted: true,
    });
    assert.equal(backend.values.has("anthropic-primary"), false);
  });

  it("runs an explicit Anthropic-compatible doctor probe without exposing its credential", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "writing-agent-cli-doctor-"));
    const providerPath = join(rootPath, "anthropic-provider.json");
    const fakeCredential = "doctor-fixture-not-a-real-key";
    const priorCredential = process.env.WA015_DOCTOR_KEY;
    const server = createServer((request, response) => {
      assert.equal(request.url, "/v1/messages");
      assert.equal(request.headers["x-api-key"], fakeCredential);
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "request-id": "doctor-request-1",
      });
      const events = [
        {
          event: "message_start",
          data: {
            type: "message_start",
            message: {
              id: "doctor-message-1",
              usage: { input_tokens: 4, output_tokens: 0 },
            },
          },
        },
        {
          event: "content_block_start",
          data: {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "doctor-tool-1",
              name: "writing_agent_capability_probe",
              input: { value: "ok" },
            },
          },
        },
        {
          event: "content_block_stop",
          data: { type: "content_block_stop", index: 0 },
        },
        {
          event: "message_delta",
          data: {
            type: "message_delta",
            delta: { stop_reason: "tool_use" },
            usage: { output_tokens: 4 },
          },
        },
        { event: "message_stop", data: { type: "message_stop" } },
      ];
      for (const entry of events) {
        response.write(`event: ${entry.event}\n`);
        response.write(`data: ${JSON.stringify(entry.data)}\n\n`);
      }
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");
    if (address === null || typeof address === "string") return;
    writeFileSync(
      providerPath,
      JSON.stringify({
        schemaVersion: 2,
        kind: "anthropic_compatible",
        providerId: "doctor-anthropic",
        baseURL: `http://127.0.0.1:${address.port}/v1`,
        credentialRef: "env:WA015_DOCTOR_KEY",
        model: "doctor-tool-model",
        tools: "supported",
        usage: "reported",
        allowInsecureHttp: true,
      }),
      "utf8",
    );
    process.env.WA015_DOCTOR_KEY = fakeCredential;
    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(
        ["doctor", "--provider-config", providerPath],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      assert.equal(exitCode, 0);
      assert.deepEqual(stderr, []);
      const result = JSON.parse(stdout.join("\n")) as {
        ok: boolean;
        tools: string;
        providerRequestId: string;
      };
      assert.deepEqual(result, {
        ok: true,
        provider: "doctor-anthropic",
        model: "doctor-tool-model",
        adapterVersion: "anthropic-messages-v1",
        streaming: "supported",
        tools: "supported",
        usage: "reported",
        providerRequestId: "doctor-request-1",
      });
      assert.equal(stdout.join("\n").includes(fakeCredential), false);
    } finally {
      server.close();
      await once(server, "close");
      if (priorCredential === undefined) delete process.env.WA015_DOCTOR_KEY;
      else process.env.WA015_DOCTOR_KEY = priorCredential;
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rebuilds a persisted request offline without constructing a model provider", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-cli-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const actor = { kind: "runtime", id: "cli-test" } as const;
    try {
      assert.equal(
        storage.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "CLI test",
          mode: "quick",
          actor,
        }).ok,
        true,
      );
      storage.createSession({
        sessionId: "session-1",
        projectId: "project-1",
        purpose: "draft",
      });
      storage.startRun({
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        planVersion: "cli-test-v1",
      });
      storage.saveRequestSnapshot({
        snapshotId: "snapshot-1",
        projectId: "project-1",
        sessionId: "session-1",
        runId: "run-1",
        request: {
          requestId: "request-1",
          model: "offline-model",
          messages: [{ role: "user", content: "离线重建" }],
          parameters: { temperature: 0 },
        },
        provider: {
          id: "offline-provider",
          adapterVersion: "1.0.0",
          serializationVersion: "offline-v1",
          normalizedPayload: {
            model: "offline-model",
            messages: [{ role: "user", content: "离线重建" }],
          },
          redactions: [],
          unreconstructableFields: [],
        },
        toolSchemas: [],
        assemblyVersion: "agent-request-v1",
        contentReferences: [],
      });
    } finally {
      storage.close();
    }

    const stdout: string[] = [];
    const stderr: string[] = [];
    try {
      const exitCode = await runCli(
        [
          "request",
          "rebuild",
          "--workspace",
          workspacePath,
          "--snapshot",
          "snapshot-1",
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      assert.equal(exitCode, 0);
      assert.deepEqual(stderr, []);
      const rebuilt = JSON.parse(stdout.join("\n")) as {
        requestId: string;
        messages: Array<{ content: string }>;
      };
      assert.equal(rebuilt.requestId, "request-1");
      assert.equal(rebuilt.messages[0]?.content, "离线重建");
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("inspects and replays locally, then resumes only through an explicit recovery decision", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-cli-recovery-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const actor = { kind: "runtime", id: "cli-recovery-test" } as const;
    try {
      assert.equal(
        storage.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "CLI recovery",
          mode: "quick",
          actor,
        }).ok,
        true,
      );
      storage.createSession({
        sessionId: "session-1",
        projectId: "project-1",
        purpose: "draft",
      });
      storage.startRun({
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        planVersion: "cli-recovery-v1",
      });
    } finally {
      storage.close();
    }

    const replayOut: string[] = [];
    const replayExit = await runCli(
      ["replay", "--workspace", workspacePath, "--run", "run-1"],
      { stdout: (line) => replayOut.push(line), stderr: () => undefined },
    );
    assert.equal(replayExit, 0);
    assert.equal(
      (JSON.parse(replayOut.join("\n")) as { run: { status: string } }).run.status,
      "running",
    );
    const afterReplay = openWorkspaceStorage({ workspacePath, readOnly: true });
    try {
      assert.deepEqual(
        afterReplay.listRunEvents("run-1").map((event) => event.type),
        ["run.started"],
      );
    } finally {
      afterReplay.close();
    }

    const inspectOut: string[] = [];
    assert.equal(
      await runCli(
        ["inspect", "--workspace", workspacePath, "--run", "run-1"],
        { stdout: (line) => inspectOut.push(line), stderr: () => undefined },
      ),
      0,
    );
    assert.equal(
      (JSON.parse(inspectOut.join("\n")) as { run: { id: string } }).run.id,
      "run-1",
    );

    const resumeOut: string[] = [];
    assert.equal(
      await runCli(
        [
          "resume",
          "--workspace",
          workspacePath,
          "--run",
          "run-1",
          "--decision",
          "resume",
        ],
        { stdout: (line) => resumeOut.push(line), stderr: () => undefined },
      ),
      0,
    );
    assert.equal(
      (JSON.parse(resumeOut.join("\n")) as { resumed: boolean }).resumed,
      true,
    );
    const resumed = openWorkspaceStorage({ workspacePath, readOnly: true });
    try {
      assert.equal(resumed.getRun("run-1")?.status, "running");
      assert.deepEqual(
        resumed.listRunEvents("run-1").slice(-2).map((event) => event.type),
        ["run.interrupted", "run.resumed"],
      );
    } finally {
      resumed.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("blocks a normal resume for unknown external outcome and accepts explicit retry-unknown", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-cli-unknown-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const actor = { kind: "runtime", id: "cli-unknown-test" } as const;
    try {
      assert.equal(
        storage.createProject({
          operationId: "create-project",
          projectId: "project-1",
          name: "CLI unknown",
          mode: "quick",
          actor,
        }).ok,
        true,
      );
      storage.createSession({
        sessionId: "session-1",
        projectId: "project-1",
        purpose: "draft",
      });
      storage.startRun({
        runId: "run-1",
        sessionId: "session-1",
        projectId: "project-1",
        planVersion: "cli-unknown-v1",
      });
      storage.prepareRuntimeOperation({
        operationId: "request-op-1",
        projectId: "project-1",
        runId: "run-1",
        kind: "model_request",
        effect: "external_side_effect",
        input: { requestId: "request-1" },
      });
      storage.dispatchRuntimeOperation({
        operationId: "request-op-1",
        projectId: "project-1",
        runId: "run-1",
        eventType: "request.dispatch_attempted",
        eventPayload: { requestId: "request-1" },
        budgetUse: { modelRequests: 1 },
      });
    } finally {
      storage.close();
    }

    const blockedErr: string[] = [];
    assert.equal(
      await runCli(
        [
          "resume",
          "--workspace",
          workspacePath,
          "--run",
          "run-1",
          "--decision",
          "resume",
        ],
        { stdout: () => undefined, stderr: (line) => blockedErr.push(line) },
      ),
      1,
    );
    assert.match(blockedErr.join("\n"), /UNKNOWN_EXTERNAL_OUTCOME/);

    const retryOut: string[] = [];
    assert.equal(
      await runCli(
        [
          "resume",
          "--workspace",
          workspacePath,
          "--run",
          "run-1",
          "--decision",
          "retry-unknown",
        ],
        { stdout: (line) => retryOut.push(line), stderr: () => undefined },
      ),
      0,
    );
    assert.equal(
      (JSON.parse(retryOut.join("\n")) as { resumed: boolean }).resumed,
      true,
    );
    const final = openWorkspaceStorage({ workspacePath, readOnly: true });
    try {
      assert.equal(final.getRun("run-1")?.status, "running");
    } finally {
      final.close();
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });

  it("runs an explicit UTF-8 material through the complete deterministic workflow", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "writing-agent-cli-run-"));
    const workspacePath = join(rootPath, "workspace");
    const briefPath = join(rootPath, "brief.json");
    const materialPath = join(rootPath, "walk.md");
    const providerPath = join(rootPath, "mock-provider.json");
    writeFileSync(
      briefPath,
      JSON.stringify({
        schemaVersion: 1,
        topic: "一次安静的下班散步",
        genre: "narrative_observation",
        audience: "忙碌的城市上班族",
        lengthTarget: { targetCharacters: 800 },
        materialIds: ["material-1"],
        constraints: ["只使用材料中的亲历细节"],
        interactionMode: "autonomous",
        authorAuthorization: {
          voice: "克制、具体",
          styleReference: null,
          styleDecision: "user_confirmed",
          directionDecision: "user_confirmed",
          firsthandMaterialIds: ["material-1"],
        },
        platform: null,
        publicationGoal: "not_applicable",
        confirmationStatus: "confirmed",
      }),
      "utf8",
    );
    writeFileSync(materialPath, "下班后我沿着河边走了二十分钟。", "utf8");
    writeFileSync(
      providerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "mock",
        model: "mock-writing-model",
        draftTemplate: "# 一次安静的下班散步\\n\\n材料记录：{{material}}",
      }),
      "utf8",
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    try {
      const exitCode = await runCli(
        [
          "run",
          "--workspace",
          workspacePath,
          "--project",
          "project-1",
          "--name",
          "CLI 文章闭环",
          "--mode",
          "quick",
          "--brief",
          briefPath,
          "--material",
          materialPath,
          "--material-id",
          "material-1",
          "--material-role",
          "user_firsthand",
          "--provider-config",
          providerPath,
        ],
        {
          stdout: (line) => stdout.push(line),
          stderr: (line) => stderr.push(line),
        },
      );
      if (exitCode !== 0) {
        const diagnostics = openWorkspaceStorage({ workspacePath, readOnly: true });
        try {
          assert.fail(JSON.stringify({ stdout, stderr, events: diagnostics.listEvents('project-1').slice(-8) }));
        } finally { diagnostics.close(); }
      }
      assert.equal(exitCode, 0);
      assert.deepEqual(stderr, []);
      const output = JSON.parse(stdout.join("\n")) as {
        status: string;
        validationKind: string;
        publicationReady: boolean;
        projectId: string;
        artifactVersionId: string;
        factGateStatus: string;
        capabilities: Record<string, string>;
      };
      assert.equal(output.status, "draft_saved");
      assert.equal(output.validationKind, "mock_verified");
      assert.equal(output.publicationReady, true);
      assert.equal(output.projectId, "project-1");
      assert.equal(output.factGateStatus, "passed");
      assert.equal(output.capabilities.factGate, "implemented_verified");

      const storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      try {
        const version = storage.getArtifactVersion(output.artifactVersionId);
        assert.match(version?.content ?? "", /材料记录：下班后我沿着河边/);
        assert.equal(storage.listMaterials("project-1").length, 1);
        assert.equal(storage.listActiveDecisions("project-1").length, 1);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("rejects a non-UTF-8 material before creating a project", async () => {
    const rootPath = mkdtempSync(join(tmpdir(), "writing-agent-cli-encoding-"));
    const workspacePath = join(rootPath, "workspace");
    const briefPath = join(rootPath, "brief.json");
    const materialPath = join(rootPath, "invalid.txt");
    const providerPath = join(rootPath, "provider.json");
    writeFileSync(
      briefPath,
      JSON.stringify({
        schemaVersion: 1,
        topic: "编码校验",
        genre: "explanatory_analysis",
        audience: "普通读者",
        lengthTarget: { targetCharacters: 600 },
        materialIds: ["material-1"],
        constraints: [],
        interactionMode: "autonomous",
        authorAuthorization: {
          voice: null,
          styleReference: null,
          styleDecision: "user_delegated",
          directionDecision: "user_confirmed",
          firsthandMaterialIds: [],
        },
        platform: null,
        publicationGoal: "not_applicable",
        confirmationStatus: "confirmed",
      }),
      "utf8",
    );
    writeFileSync(materialPath, Uint8Array.from([0xc3, 0x28]));
    writeFileSync(
      providerPath,
      JSON.stringify({
        schemaVersion: 1,
        kind: "mock",
        model: "mock-writing-model",
        draftTemplate: "{{material}}",
      }),
      "utf8",
    );
    const errors: string[] = [];
    try {
      assert.equal(
        await runCli(
          [
            "run",
            "--workspace",
            workspacePath,
            "--project",
            "project-1",
            "--name",
            "编码校验",
            "--mode",
            "quick",
            "--brief",
            briefPath,
            "--material",
            materialPath,
            "--material-id",
            "material-1",
            "--material-role",
            "source_verified",
            "--provider-config",
            providerPath,
          ],
          { stdout: () => undefined, stderr: (line) => errors.push(line) },
        ),
        1,
      );
      assert.match(errors.join("\n"), /INPUT_UTF8_INVALID/);
      const storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      try {
        assert.equal(storage.inspectProject("project-1"), null);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(rootPath, { recursive: true, force: true });
    }
  });

  it("saves a working copy offline and refuses a formal export before the fact gate passes", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "writing-agent-cli-export-"));
    const storage = openWorkspaceStorage({ workspacePath });
    const actor = { kind: "user", id: "cli-export-test" } as const;
    try {
      assert.equal(
        storage.createProject({
          operationId: "create-export-project",
          projectId: "project-1",
          name: "CLI export",
          mode: "quick",
          actor,
        }).ok,
        true,
      );
      assert.equal(
        storage.commitArtifactVersion({
          operationId: "create-export-body",
          projectId: "project-1",
          expectedProjectRevision: 0,
          kind: "body",
          logicalKey: "main",
          baseVersionId: null,
          content: "# CLI 工作稿\n\n尚未核查。",
          reason: "fixture",
          actor,
        }).ok,
        true,
      );
    } finally {
      storage.close();
    }

    const workingOut: string[] = [];
    const workingErr: string[] = [];
    try {
      assert.equal(
        await runCli(
          [
            "export",
            "working-copy",
            "--workspace",
            workspacePath,
            "--project",
            "project-1",
            "--operation",
            "cli-working-copy",
          ],
          {
            stdout: (line) => workingOut.push(line),
            stderr: (line) => workingErr.push(line),
          },
        ),
        0,
      );
      assert.deepEqual(workingErr, []);
      const saved = JSON.parse(workingOut.join("\n")) as {
        mode: string;
        relativePath: string;
      };
      assert.equal(saved.mode, "working_copy");
      assert.equal(existsSync(join(workspacePath, ...saved.relativePath.split("/"))), true);

      const formalErr: string[] = [];
      assert.equal(
        await runCli(
          [
            "export",
            "publication",
            "--workspace",
            workspacePath,
            "--project",
            "project-1",
            "--format",
            "txt",
            "--operation",
            "cli-publication",
          ],
          { stdout: () => undefined, stderr: (line) => formalErr.push(line) },
        ),
        1,
      );
      assert.match(formalErr.join("\n"), /FACT_GATE_NOT_PASSED/);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
