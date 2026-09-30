import type { CredentialBroker } from "../../../packages/runtime/credentials/src/index.js";
import type { CliIo } from "./index.js";

class CredentialCommandInputError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "CredentialCommandInputError";
  }
}

function requiredOption(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index === -1 ? undefined : args[index + 1];
  if (value === undefined || value.trim().length === 0) {
    throw new CredentialCommandInputError(
      "CLI_OPTION_REQUIRED",
      `${name} is required`,
    );
  }
  return value;
}

export async function runCredentialCommand(
  args: readonly string[],
  io: CliIo,
  credentials: CredentialBroker,
): Promise<number> {
  const action = args[1];
  if (action !== "set" && action !== "inspect" && action !== "delete") {
    throw new CredentialCommandInputError(
      "CLI_CREDENTIAL_ACTION_INVALID",
      "credential action must be set, inspect or delete",
    );
  }
  const id = requiredOption(args, "--id");
  if (action === "inspect") {
    io.stdout(JSON.stringify(await credentials.inspect(`managed:${id}`), null, 2));
    return 0;
  }
  if (action === "delete") {
    await credentials.deleteManaged(id);
    io.stdout(
      JSON.stringify({ reference: `managed:${id}`, deleted: true }, null, 2),
    );
    return 0;
  }

  const environmentName = requiredOption(args, "--from-env");
  const secret = await credentials.resolve(`env:${environmentName}`);
  if (secret === undefined || secret.trim().length === 0) {
    throw new CredentialCommandInputError(
      "CREDENTIAL_SOURCE_MISSING",
      "Credential source environment variable is missing",
    );
  }
  const result = await credentials.saveManaged(id, secret, "system");
  io.stdout(JSON.stringify(result, null, 2));
  if (result.persistence !== "system") {
    io.stderr(
      `Credential was not persisted: ${result.fallbackReason ?? "system_unavailable"}`,
    );
    return 1;
  }
  return 0;
}
