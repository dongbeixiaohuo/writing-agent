import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPERT_INSTRUCTION_CATALOG,
  buildExpertInstructions,
} from "../src/expert-instructions.js";

describe("expert instruction migration", () => {
  it("exposes the core workflow experts with distinct professional instructions", () => {
    const roles = [
      "research",
      "outline",
      "draft",
      "review_editor",
      "review_publish",
      "review_reader",
      "central_revision",
      "language_review",
      "fact_check",
      "director",
    ] as const;

    assert.deepEqual(
      roles.filter((role) => !(role in EXPERT_INSTRUCTION_CATALOG)),
      [],
    );
    const instructions = roles.map((role) => buildExpertInstructions(role));
    assert.equal(new Set(instructions).size, roles.length);
    assert.match(buildExpertInstructions("research"), /反证.*适用边界/u);
    assert.match(buildExpertInstructions("central_revision"), /采纳.*不采纳.*理由/u);
  });

  it("maps every specialist role and legacy alias to audited source metadata", () => {
    const specialistRoles = [
      "topic_generator",
      "topic_research",
      "position",
      "concretizer",
      "empathy",
      "title",
      "opening",
      "style_modeler",
      "illustrator",
      "memory",
      "retrospective",
    ] as const;

    for (const role of specialistRoles) {
      const metadata = EXPERT_INSTRUCTION_CATALOG[role];
      assert.equal(metadata.role, role);
      assert.equal(metadata.category, "specialist");
      assert.ok(metadata.sourceFiles.length > 0, `${role} has no source mapping`);
      assert.equal(
        metadata.sourceFiles.every((source) => source.startsWith("claude-runtime/")),
        true,
      );
      assert.ok(buildExpertInstructions(role).length > 300, `${role} is only a slogan`);
    }

    assert.equal(
      buildExpertInstructions("humanizer"),
      buildExpertInstructions("language_review"),
    );
    assert.equal(
      buildExpertInstructions("style-modeler"),
      buildExpertInstructions("style_modeler"),
    );
    assert.throws(() => buildExpertInstructions("not-a-role"), /Unknown expert role/u);
  });

  it("keeps model instructions host-neutral and subordinate to caller protocols", () => {
    const forbiddenHostDependencies =
      /\.claude|claude-runtime|run_manifest|articles\/|\bRead\b|\bWrite\b|\bBash\b|\bPython\b|WebSearch|WebFetch|\.md\b/u;

    for (const role of Object.keys(EXPERT_INSTRUCTION_CATALOG)) {
      const instruction = buildExpertInstructions(role);
      assert.match(instruction, /只补充.*专业判断/u);
      assert.match(instruction, /输出 schema.*提交格式.*工具协议/u);
      assert.match(instruction, /scoped context/u);
      assert.match(instruction, /不声称已经联网.*生成图片.*外部操作/u);
      assert.doesNotMatch(instruction, forbiddenHostDependencies, role);
    }
  });

  it("preserves the original expert methods instead of reducing them to slogans", () => {
    const editor = buildExpertInstructions("review_editor");
    const publish = buildExpertInstructions("review_publish");
    const reader = buildExpertInstructions("review_reader");
    assert.match(reader, /朋友圈.*熟人.*转发/u);
    assert.match(reader, /模拟读者.*即时感受/u);
    assert.match(reader, /点开.*继续.*弃读.*读完.*转发/u);
    assert.match(buildExpertInstructions('fact_check'), /可被外部世界证伪[\s\S]*第一人称亲历叙事[\s\S]*不生成 C 编号/u);
    assert.match(editor, /写作工艺.*结构.*作者声音/u);
    assert.doesNotMatch(editor, /CTR|完读率/u);
    assert.match(publish, /读者价值.*全文承诺.*发布风险/u);
    assert.match(reader, /公众号.*今日头条.*知乎.*平台未知/u);
    assert.match(reader, /传播目标.*不适用.*跳过.*分享.*收藏.*互动/u);
    assert.match(reader, /公众号.*卡片承诺.*首屏承接/u);
    assert.match(reader, /今日头条.*信息流一致性.*前三屏推进/u);
    assert.match(reader, /知乎.*问答贴合.*专业密度/u);
    assert.equal(new Set([editor, publish, reader]).size, 3);

    assert.match(buildExpertInstructions("position"), /推翻.*最强反例.*适用边界/u);
    assert.match(buildExpertInstructions("draft"), /作者声音.*禁止第一人称亲历/u);
    assert.match(buildExpertInstructions("language_review"), /只有在收益明确.*局部最小修改/u);
    assert.match(buildExpertInstructions("fact_check"), /完整正文.*最终标题.*分发文案/u);
    assert.match(buildExpertInstructions("style_modeler"), /至少三组独立.*盲测/u);
    assert.match(buildExpertInstructions("style_modeler"), /超过 30% 不得验证通过/u);
    assert.match(buildExpertInstructions("memory"), /只有.*user_edit.*用户偏好/u);
    assert.match(buildExpertInstructions("retrospective"), /相关性不能写成因果/u);
    assert.match(buildExpertInstructions("illustrator"), /生成失败.*不写假路径.*不声称图片成功/u);
  });
});
