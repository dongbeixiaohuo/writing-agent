import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolveDesktopRunEnvironment } from "../src/run-environment.js";

test("desktop run environment keeps production, smoke, and visible UX data isolated", () => {
  const tempPath = "C:\\Temp";

  assert.deepEqual(resolveDesktopRunEnvironment({ tempPath }), {
    mode: "production",
    id: null,
    root: null,
    showWindow: true,
    disableHardwareAcceleration: false,
  });
  assert.deepEqual(resolveDesktopRunEnvironment({ tempPath, smokeId: "smoke-12345678" }), {
    mode: "smoke",
    id: "smoke-12345678",
    root: join(tempPath, "writing-agent-desktop-smoke-smoke-12345678"),
    showWindow: false,
    disableHardwareAcceleration: true,
  });
  assert.deepEqual(resolveDesktopRunEnvironment({ tempPath, testId: "ux-final-20260918" }), {
    mode: "test",
    id: "ux-final-20260918",
    root: join(tempPath, "writing-agent-desktop-test-ux-final-20260918"),
    showWindow: true,
    disableHardwareAcceleration: false,
  });
});

test("desktop run environment rejects path-shaped IDs and conflicting isolation modes", () => {
  assert.throws(
    () => resolveDesktopRunEnvironment({ tempPath: "C:\\Temp", testId: "..\\escape" }),
    /DESKTOP_TEST_ID_INVALID/u,
  );
  assert.throws(
    () => resolveDesktopRunEnvironment({
      tempPath: "C:\\Temp",
      smokeId: "smoke-12345678",
      testId: "ux-final-20260918",
    }),
    /DESKTOP_RUN_MODE_CONFLICT/u,
  );
});
