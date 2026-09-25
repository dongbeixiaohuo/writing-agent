import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { openWorkspaceStorage } from "../../storage/src/index.js";
import {
  AuthorPreferenceError,
  getApprovedAuthorPreferences,
  setAuthorPreferenceFromUserText,
} from "../src/author-preferences.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "author-preferences-"));
  const storage = openWorkspaceStorage({ workspacePath: directory });
  for (const projectId of ["project-a", "project-b"]) {
    assert.equal(storage.createProject({
      operationId: `create-${projectId}`,
      projectId,
      name: projectId,
      mode: "quick",
      actor: { kind: "user", id: "user-1" },
    }).ok, true);
  }
  return {
    storage,
    close() {
      storage.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("approved author preferences", () => {
  it("reads only explicit user-approved rules across projects as bounded reference preferences", () => {
    const f = fixture();
    try {
      setAuthorPreferenceFromUserText(
        f.storage,
        "project-a",
        "remember-a",
        "记住我的写作偏好：开头不要用宏大叙事。",
      );
      setAuthorPreferenceFromUserText(
        f.storage,
        "project-a",
        "remember-a-2",
        "记住我的写作偏好：论据不足时保留不确定性。",
      );
      setAuthorPreferenceFromUserText(
        f.storage,
        "project-b",
        "remember-b",
        "记住我的写作偏好：结尾留一句可供思考的话。",
      );

      const approved = getApprovedAuthorPreferences(f.storage);
      assert.deepEqual(approved.rules.map((rule) => rule.text), [
        "结尾留一句可供思考的话。",
        "论据不足时保留不确定性。",
        "开头不要用宏大叙事。",
      ]);
      assert.deepEqual(new Set(approved.rules.map((rule) => rule.sourceProjectId)),
        new Set(["project-a", "project-b"]));
      for (const rule of approved.rules) {
        assert.equal(rule.sourceUserText, `记住我的写作偏好：${rule.text}`);
      }
      assert.equal(approved.instructionAuthority, "none");
      assert.equal(approved.scope, "writing_preference_only");
      assert.equal(approved.mayAffectMaterialTrust, false);
      assert.equal(approved.mayExpandPermissions, false);
      assert.ok(approved.rules.length <= 20);
      assert.ok(approved.totalChars <= 20_000);
      for (const projectId of ["project-a", "project-b"]) {
        const artifact = f.storage.listArtifactVersions(
          projectId,
          "report",
          "author-approved-preferences",
        ).at(-1)!;
        assert.equal(artifact.actor.kind, "user");
        assert.match(JSON.parse(artifact.content).sourceUserText, /^记住我的写作偏好：/u);
      }
    } finally {
      f.close();
    }
  });

  it("rejects ordinary feedback, quoted third-party requests, model self-approval, empty and oversized rules", () => {
    const f = fixture();
    try {
      const rejected: unknown[] = [
        "这段写得太长了",
        "张三说：记住我的写作偏好：多用数据",
        "模型建议并自动批准：多用反问",
        "记住我的写作偏好：   ",
        `记住我的写作偏好：${"x".repeat(20_001)}`,
      ];
      for (const [index, userText] of rejected.entries()) {
        assert.throws(
          () => setAuthorPreferenceFromUserText(
            f.storage,
            "project-a",
            `reject-${index}`,
            userText as string,
          ),
          (error: unknown) => error instanceof AuthorPreferenceError,
        );
      }
      assert.throws(
        () => setAuthorPreferenceFromUserText(
          f.storage,
          "project-a",
          "structured-self-approval",
          { userText: "记住我的写作偏好：多用反问", approved: true } as never,
        ),
        (error: unknown) => error instanceof AuthorPreferenceError,
      );
      assert.equal(
        f.storage.listArtifactVersions("project-a", "report", "author-approved-preferences").length,
        0,
      );
    } finally {
      f.close();
    }
  });

  it("soft-clears one project's latest preferences without deleting or reviving its history", () => {
    const f = fixture();
    try {
      setAuthorPreferenceFromUserText(
        f.storage,
        "project-a",
        "remember-old",
        "记住我的写作偏好：这条旧偏好不能复活。",
      );
      const cleared = setAuthorPreferenceFromUserText(
        f.storage,
        "project-a",
        "clear-a",
        "忘记我的写作偏好",
      );
      assert.equal(cleared.status, "cleared");
      assert.equal(cleared.instructionAuthority, "none");
      assert.deepEqual(getApprovedAuthorPreferences(f.storage).rules, []);
      const history = f.storage.listArtifactVersions(
        "project-a",
        "report",
        "author-approved-preferences",
      );
      assert.equal(history.length, 2);
      assert.equal(JSON.parse(history[0]!.content).status, "approved");
      assert.equal(JSON.parse(history[1]!.content).status, "cleared");
    } finally {
      f.close();
    }
  });

  it("replays the same operation idempotently and rejects reusing it for another rule", () => {
    const f = fixture();
    try {
      const input = [
        f.storage,
        "project-a",
        "same-operation",
        "记住我的写作偏好：优先用短句表达结论。",
      ] as const;
      const first = setAuthorPreferenceFromUserText(...input);
      const revision = f.storage.inspectProject("project-a")!.revision;
      const replay = setAuthorPreferenceFromUserText(...input);
      assert.deepEqual(replay, first);
      assert.equal(f.storage.inspectProject("project-a")!.revision, revision);
      assert.equal(
        f.storage.listArtifactVersions("project-a", "report", "author-approved-preferences").length,
        1,
      );
      assert.throws(
        () => setAuthorPreferenceFromUserText(
          f.storage,
          "project-a",
          "same-operation",
          "记住我的写作偏好：改成另一条偏好。",
        ),
        (error: unknown) => error instanceof AuthorPreferenceError &&
          error.code === "IDEMPOTENCY_KEY_REUSED",
      );
    } finally {
      f.close();
    }
  });
});
