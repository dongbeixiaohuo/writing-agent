#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { WritingApplicationService } from "../../../packages/application/src/index.js";
import { createApplicationBridge } from "../../../packages/client-bridge/src/application-bridge.js";
import { startLocalWebHost } from "../../../packages/client-bridge/src/local-web-host.js";
import { createFileUiSettingsPersistence } from "../../../packages/client-bridge/src/ui-settings-persistence.js";
import {
  ModelProviderBase,
  type ModelRequest,
  type ProviderStreamEvent,
} from "../../../packages/runtime/llm/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";
import type { WritingBrief } from "../../../packages/writing-core/src/index.js";

interface FixtureProject {
  readonly id: string;
  readonly name: string;
  readonly sessionId: string;
  readonly sessionTitle: string;
  readonly topic: string;
  readonly body?: string;
  readonly replacement?: string;
}

interface Wa025Fixture {
  readonly fixtureId: string;
  readonly primaryProject: FixtureProject;
  readonly secondaryProject: FixtureProject;
}

const actor = { kind: "user", id: "wa025-browser-fixture" } as const;

class NoNetworkProvider extends ModelProviderBase {
  constructor() {
    super("wa025-no-network", "1.0.0", {
      protocol: "mock",
      streaming: "supported",
      tools: "supported",
      usage: "unknown",
    });
  }

  protected async *providerStream(
    _request: ModelRequest,
  ): AsyncIterable<ProviderStreamEvent> {
    throw new Error("WA025_PROVIDER_MUST_NOT_BE_CALLED");
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function brief(project: FixtureProject, materialId: string): WritingBrief {
  return {
    schemaVersion: 1,
    topic: project.topic,
    genre: "explanatory_analysis",
    audience: "Writing Agent 维护者",
    lengthTarget: { targetCharacters: 800 },
    materialIds: [materialId],
    constraints: ["只使用确定性合成材料", "不得调用外部模型"],
    interactionMode: "autonomous",
    authorAuthorization: {
      voice: "克制、具体",
      styleReference: null,
      styleDecision: "user_confirmed",
      directionDecision: "user_confirmed",
      firsthandMaterialIds: [],
    },
    platform: null,
    publicationGoal: "not_applicable",
    confirmationStatus: "confirmed",
  };
}

function seedProject(
  service: WritingApplicationService,
  storage: ReturnType<typeof openWorkspaceStorage>,
  project: FixtureProject,
  withPassedFactGate: boolean,
): void {
  const materialId = `${project.id}-material`;
  const created = service.createProject({
    operationId: `${project.id}-create`,
    projectId: project.id,
    name: project.name,
    mode: "quick",
    actor,
  });
  if (!created.ok) throw new Error(`WA025_CREATE_FAILED:${project.id}`);

  const imported = service.importMaterial({
    operationId: `${project.id}-material`,
    projectId: project.id,
    expectedProjectRevision: 0,
    materialId,
    displayName: "确定性验收材料.md",
    sourceKind: "utf8_file",
    sourceReference: `fixture://${project.id}/material`,
    role: "source_verified",
    trustLabel: "user_provided_untrusted",
    permissionScope: "project_only",
    content: `合成材料：${project.topic}`,
    actor,
  });
  if (!imported.ok) throw new Error(`WA025_IMPORT_FAILED:${project.id}`);

  const savedBrief = service.saveWritingBrief({
    operationId: `${project.id}-brief`,
    projectId: project.id,
    expectedProjectRevision: imported.projectRevision,
    baseVersionId: null,
    brief: brief(project, materialId),
    actor,
  });
  if (!savedBrief.ok) throw new Error(`WA025_BRIEF_FAILED:${project.id}`);

  let projectRevision = savedBrief.projectRevision;
  if (project.body !== undefined) {
    const body = storage.commitArtifactVersion({
      operationId: `${project.id}-body`,
      projectId: project.id,
      expectedProjectRevision: projectRevision,
      kind: "body",
      logicalKey: "main",
      baseVersionId: null,
      content: project.body,
      reason: "WA-025 deterministic fixture",
      actor,
    });
    if (!body.ok) throw new Error(`WA025_BODY_FAILED:${project.id}`);
    projectRevision = body.projectRevision;

    if (withPassedFactGate) {
      const title = storage.commitArtifactVersion({
        operationId: `${project.id}-title`,
        projectId: project.id,
        expectedProjectRevision: projectRevision,
        kind: "title",
        logicalKey: "main",
        baseVersionId: null,
        content: "- 选择状态：已锁定\n- 最终标题：「验收标题」\n",
        reason: "WA-025 deterministic fixture",
        actor,
      });
      if (!title.ok) throw new Error(`WA025_TITLE_FAILED:${project.id}`);
      projectRevision = title.projectRevision;

      const evidence = storage.commitArtifactVersion({
        operationId: `${project.id}-evidence`,
        projectId: project.id,
        expectedProjectRevision: projectRevision,
        kind: "evidence",
        logicalKey: "main",
        baseVersionId: null,
        content: JSON.stringify({
          claims: [],
          notes: "确定性验收正文不包含需要外部证明的事实声明。",
        }),
        reason: "WA-025 deterministic fixture",
        actor,
      });
      if (!evidence.ok) throw new Error(`WA025_EVIDENCE_FAILED:${project.id}`);
      projectRevision = evidence.projectRevision;

      const frozen = service.createFactCheckSnapshot({
        operationId: `${project.id}-fact-freeze`,
        projectId: project.id,
        expectedProjectRevision: projectRevision,
        bodyVersionId: body.result.versionId,
        titleVersionId: title.result.versionId,
        evidenceVersionId: evidence.result.versionId,
        actor,
      });
      if (!frozen.ok) throw new Error(`WA025_FACT_FREEZE_FAILED:${project.id}`);
      projectRevision = frozen.projectRevision;

      const assessed = service.evaluateFactCheckSnapshot({
        operationId: `${project.id}-fact-evaluate`,
        projectId: project.id,
        expectedProjectRevision: projectRevision,
        snapshotId: frozen.result.snapshotId,
        payload: {
          schemaVersion: "fact-check-v2",
          snapshotId: frozen.result.snapshotId,
          bodyVersionId: body.result.versionId,
          titleVersionId: title.result.versionId,
          coverage: { body: true, title: true, distributionCopy: true },
          claims: [],
          noFactualClaimsReason: "本验收夹具只描述本次确定性操作。",
        },
        actor,
      });
      if (!assessed.ok) throw new Error(`WA025_FACT_EVALUATE_FAILED:${project.id}`);
    }
  }

  storage.createSession({
    sessionId: project.sessionId,
    projectId: project.id,
    purpose: project.sessionTitle,
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const workspacePath = resolve(requiredOption(args, "--workspace"));
  const fixturePath = resolve(
    requiredOption(args, "--fixture"),
  );
  const fixture = JSON.parse(
    readFileSync(fixturePath, "utf8"),
  ) as Wa025Fixture;
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({
    storage,
    provider: new NoNetworkProvider(),
  });
  seedProject(service, storage, fixture.primaryProject, true);
  seedProject(service, storage, fixture.secondaryProject, false);

  const host = await startLocalWebHost({
    staticRoot: resolve("apps/web/dist/production"),
    bridgeFactory: () =>
      createApplicationBridge({
        service,
        workspaceId: `workspace-${fixture.fixtureId}`,
        model: {
          model: "wa025-no-network",
          providerLabel: "WA-025 确定性本地夹具",
          credentialReference: null,
          parameters: { temperature: 0, toolChoice: "auto" },
        },
        clientBuild: "writing-agent-web-wa025",
        runtimeBuild: "writing-agent-runtime-wa025",
        pollIntervalMs: 20,
        uiSettingsPersistence: createFileUiSettingsPersistence({
          filePath: join(
            workspacePath,
            ".writing-agent",
            "ui-settings.json",
          ),
        }),
      }),
    pollTimeoutMs: 25,
  });

  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      origin: host.origin,
      fixtureId: fixture.fixtureId,
    })}\n`,
  );

  await new Promise<void>((resolveStop) => {
    const stop = (): void => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await host.close();
  storage.close();
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "WA025_HOST_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
