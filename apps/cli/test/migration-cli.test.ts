import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";

import { runCli } from "../src/index.js";
import { openWorkspaceStorage } from "../../../packages/storage/src/index.js";

const FIXTURES = resolve("tests", "fixtures", "legacy");

describe("legacy migration CLI", () => {
  it("runs scan, apply and confirmed project rollback without the old application", async () => {
    const root = mkdtempSync(join(tmpdir(), "writing-agent-migrate-cli-"));
    const sourcePath = join(root, "legacy-project");
    const workspacePath = join(root, "workspace");
    const planPath = join(root, "plan.json");
    cpSync(join(FIXTURES, "manifest-project"), sourcePath, { recursive: true });

    try {
      const scanOut: string[] = [];
      const scanErr: string[] = [];
      assert.equal(
        await runCli(
          [
            "migrate",
            "scan",
            "--kind",
            "manifest",
            "--source",
            sourcePath,
            "--workspace",
            workspacePath,
          ],
          { stdout: (line) => scanOut.push(line), stderr: (line) => scanErr.push(line) },
        ),
        0,
      );
      assert.deepEqual(scanErr, []);
      const plan = JSON.parse(scanOut.join("\n")) as {
        projects: Array<{ targetProjectId: string }>;
      };
      writeFileSync(planPath, `${scanOut.join("\n")}\n`, "utf8");

      const applyOut: string[] = [];
      assert.equal(
        await runCli(
          ["migrate", "apply", "--plan", planPath],
          { stdout: (line) => applyOut.push(line), stderr: () => undefined },
        ),
        0,
      );
      const report = JSON.parse(applyOut.join("\n")) as { reportPath: string };
      const projectId = plan.projects[0]?.targetProjectId ?? "";
      let storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      try {
        assert.notEqual(storage.inspectProject(projectId), null);
      } finally {
        storage.close();
      }

      const rollbackOut: string[] = [];
      assert.equal(
        await runCli(
          [
            "migrate",
            "rollback",
            "--workspace",
            workspacePath,
            "--report",
            report.reportPath,
            "--confirm-project",
            projectId,
          ],
          { stdout: (line) => rollbackOut.push(line), stderr: () => undefined },
        ),
        0,
      );
      assert.equal(
        (JSON.parse(rollbackOut.join("\n")) as { deletedProjectId: string }).deletedProjectId,
        projectId,
      );
      storage = openWorkspaceStorage({ workspacePath, readOnly: true });
      try {
        assert.equal(storage.inspectProject(projectId), null);
      } finally {
        storage.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
