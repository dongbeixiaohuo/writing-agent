import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ActorSchema,
  ArtifactKindSchema,
  canonicalJson,
  contentHash,
  ProjectModeSchema,
} from "../src/index.js";

describe("writing-core public domain contracts", () => {
  it("accepts explicit actors and rejects empty identities", () => {
    assert.deepEqual(ActorSchema.parse({ kind: "user", id: "user-1" }), {
      kind: "user",
      id: "user-1",
    });
    assert.throws(() => ActorSchema.parse({ kind: "user", id: "" }));
  });

  it("produces deterministic command and content hashes", () => {
    const left = canonicalJson({ projectId: "p1", payload: { b: 2, a: 1 } });
    const right = canonicalJson({ payload: { a: 1, b: 2 }, projectId: "p1" });

    assert.equal(left, right);
    assert.equal(
      contentHash("正文"),
      "d661c3d96d53ebc0ca8a55aae24b5df4a4d1bf28d37337b982fe8ebf54846eeb",
    );
  });

  it("uses the PRD quick/deep modes and supports the declared artifact kinds", () => {
    assert.equal(ProjectModeSchema.parse("deep"), "deep");
    assert.throws(() => ProjectModeSchema.parse("collaborative"));
    for (const kind of [
      "body",
      "outline",
      "title",
      "evidence",
      "review",
      "report",
    ]) {
      assert.equal(ArtifactKindSchema.parse(kind), kind);
    }
  });
});
