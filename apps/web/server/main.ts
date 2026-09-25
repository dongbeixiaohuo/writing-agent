#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { WritingApplicationService } from "../../../packages/application/src/index.js";
import { createApplicationBridge } from "../../../packages/client-bridge/src/application-bridge.js";
import { startLocalWebHost } from "../../../packages/client-bridge/src/local-web-host.js";
import { createFileUiSettingsPersistence } from "../../../packages/client-bridge/src/ui-settings-persistence.js";
import {
  createConfiguredProvider,
  createDefaultCredentialBroker,
  parseProviderConfig,
} from "../../../packages/runtime/provider-config/src/index.js";
import { AuthorizedPathPolicy } from "../../../packages/runtime/tools/src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  return value === undefined || value.trim().length === 0 ? undefined : value;
}

function requiredOption(args: readonly string[], name: string): string {
  const value = option(args, name);
  if (value === undefined) throw new Error(`${name} is required`);
  return value;
}

function workspaceId(path: string): string {
  return `workspace-${createHash("sha256").update(path, "utf8").digest("hex").slice(0, 16)}`;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const workspacePath = resolve(requiredOption(args, "--workspace"));
  const providerInputPath = resolve(requiredOption(args, "--provider-config"));
  const staticRoot = resolve("apps/web/dist/production");
  const paths = AuthorizedPathPolicy.create({
    workspaceRoot: workspacePath,
    importedPaths: [providerInputPath],
  });
  const providerPath = paths.resolveReadableFile(providerInputPath).path;
  const providerConfig = parseProviderConfig(
    JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(providerPath),
      ),
    ) as unknown,
  );
  const provider = createConfiguredProvider(
    providerConfig,
    createDefaultCredentialBroker(),
  );
  const storage = openWorkspaceStorage({ workspacePath });
  const service = new WritingApplicationService({ storage, provider });
  const uiSettingsPersistence = createFileUiSettingsPersistence({
    filePath: join(workspacePath, ".writing-agent", "ui-settings.json"),
  });
  const recovered = service.recoverWorkspace();
  const host = await startLocalWebHost({
    staticRoot,
    bridgeFactory: () =>
      createApplicationBridge({
        service,
        workspaceId: workspaceId(workspacePath),
        model: {
          model: providerConfig.model,
          providerLabel: `${providerConfig.providerId} · ${providerConfig.model}`,
          credentialReference: providerConfig.credentialRef,
          parameters: { temperature: 0, toolChoice: "auto" },
        },
        clientBuild: "writing-agent-web-v3",
        runtimeBuild: "writing-agent-runtime-v1",
        uiSettingsPersistence,
      }),
  });

  process.stdout.write(
    `${JSON.stringify({
      status: "ready",
      origin: host.origin,
      recoveredRuns: recovered.map((run) => ({
        projectId: run.projectId,
        runId: run.runId,
        status: run.status,
      })),
    })}\n`,
  );

  await new Promise<void>((resolveStop) => {
    const stop = (): void => resolveStop();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  await host.close();
  storage.close();
  return 0;
}

main()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error: unknown) => {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? error.code
        : error instanceof Error
            ? error.name
            : "LOCAL_WEB_START_FAILED";
    process.stderr.write(`Writing Agent Web failed: ${code}\n`);
    process.exitCode = 1;
  });
