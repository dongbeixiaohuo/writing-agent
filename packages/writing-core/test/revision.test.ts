import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  applyRevisionEdits,
  parseBodyDocument,
  reconcileBodyDocument,
} from "../src/index.js";

describe("body block revision contracts", () => {
  it("parses stable markdown blocks and preserves unambiguous identities", () => {
    const base = parseBodyDocument(
      "version-1",
      "# 标题\n\n第一段。\n\n- 条目一\n- 条目二",
    );
    assert.deepEqual(
      base.blocks.map((block) => block.kind),
      ["heading", "paragraph", "list"],
    );
    assert.equal(base.blocks.every((block) => block.contentHash.length === 64), true);

    const next = reconcileBodyDocument(
      "version-2",
      "# 标题\n\n新段落。\n\n第一段。\n\n- 条目一\n- 条目二",
      base,
    );
    assert.equal(next.blocks[0]?.id, base.blocks[0]?.id);
    assert.equal(next.blocks[2]?.id, base.blocks[1]?.id);
    assert.equal(next.blocks[3]?.id, base.blocks[2]?.id);
    assert.notEqual(next.blocks[1]?.id, base.blocks[1]?.id);
  });

  it("applies whole-block edits only when target IDs and hashes match", () => {
    const base = parseBodyDocument("version-1", "# 标题\n\n第一段。\n\n第二段。");
    const target = base.blocks[1];
    assert.notEqual(target, undefined);
    if (target === undefined) return;

    const changed = applyRevisionEdits("version-2", base, [
      {
        type: "replace",
        targetBlockId: target.id,
        baseBlockHash: target.contentHash,
        content: "修改后的第一段。",
      },
    ], "proposal-1");
    assert.equal(changed.content, "# 标题\n\n修改后的第一段。\n\n第二段。");
    assert.equal(changed.blocks[1]?.id, target.id);
    assert.equal(changed.blocks[2]?.id, base.blocks[2]?.id);

    assert.throws(
      () => applyRevisionEdits("version-3", base, [{
        type: "delete",
        targetBlockId: target.id,
        baseBlockHash: "0".repeat(64),
      }], "proposal-stale"),
      /BLOCK_HASH_CONFLICT/u,
    );
  });
});
