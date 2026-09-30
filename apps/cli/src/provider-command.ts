import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  createConfiguredProvider,
  parseProviderConfig,
} from "../../../packages/runtime/provider-config/src/index.js";
import { probeModelConnection } from "../../../packages/runtime/llm/src/index.js";
import type { CredentialBroker } from "../../../packages/runtime/credentials/src/index.js";
import type { CliIo } from "./index.js";

class ProviderDoctorInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderDoctorInputError";
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new ProviderDoctorInputError(
      "CLI_OPTION_REQUIRED",
      `${name} is required`,
    );
  }
  return value;
}

function readProviderConfig(path: string): unknown {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch {
    throw new ProviderDoctorInputError(
      "INPUT_UTF8_INVALID",
      "Provider configuration must be readable UTF-8",
    );
  }
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new ProviderDoctorInputError(
      "INPUT_JSON_INVALID",
      "Provider configuration must be valid JSON",
    );
  }
}

export async function runProviderDoctor(
  args: readonly string[],
  io: CliIo,
  credentials: CredentialBroker,
): Promise<number> {
  const providerPath = requiredOption(args, "--provider-config");
  const config = parseProviderConfig(readProviderConfig(providerPath));
  const provider = createConfiguredProvider(config, credentials);
  const result = await probeModelConnection(provider, {
    requestId: randomUUID(),
    model: config.model,
    testTools: true,
  });
  io.stdout(JSON.stringify(result, null, 2));
  if (!result.ok) {
    io.stderr(`Provider doctor failed: ${result.error.code}`);
    return 1;
  }
  return 0;
}
