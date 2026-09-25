import { join } from "node:path";

export type DesktopRunMode = "production" | "smoke" | "test";

export interface DesktopRunEnvironment {
  readonly mode: DesktopRunMode;
  readonly id: string | null;
  readonly root: string | null;
  readonly showWindow: boolean;
  readonly disableHardwareAcceleration: boolean;
}

export interface DesktopRunEnvironmentInput {
  readonly tempPath: string;
  readonly smokeId?: string | undefined;
  readonly testId?: string | undefined;
}

const SAFE_ID = /^[A-Za-z0-9_-]{8,64}$/u;

function parseId(value: string | undefined, code: string): string | null {
  if (value === undefined || value.length === 0) return null;
  if (!SAFE_ID.test(value)) throw new Error(code);
  return value;
}

export function resolveDesktopRunEnvironment(
  input: DesktopRunEnvironmentInput,
): DesktopRunEnvironment {
  const smokeId = parseId(input.smokeId, "DESKTOP_SMOKE_ID_INVALID");
  const testId = parseId(input.testId, "DESKTOP_TEST_ID_INVALID");
  if (smokeId !== null && testId !== null) throw new Error("DESKTOP_RUN_MODE_CONFLICT");
  if (smokeId !== null) {
    return {
      mode: "smoke",
      id: smokeId,
      root: join(input.tempPath, `writing-agent-desktop-smoke-${smokeId}`),
      showWindow: false,
      disableHardwareAcceleration: true,
    };
  }
  if (testId !== null) {
    return {
      mode: "test",
      id: testId,
      root: join(input.tempPath, `writing-agent-desktop-test-${testId}`),
      showWindow: true,
      disableHardwareAcceleration: false,
    };
  }
  return {
    mode: "production",
    id: null,
    root: null,
    showWindow: true,
    disableHardwareAcceleration: false,
  };
}
