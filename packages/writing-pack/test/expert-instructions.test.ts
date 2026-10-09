import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXPERT_INSTRUCTION_CATALOG,
  buildExpertInstructions,
} from "../src/expert-instructions.js";

describe("expert instruction migration", () => {
  it('separates publishable prose from internal material audit notes without erasing factual uncertainty', () => {
    for (const role of ['director', 'draft', 'central_revision', 'language_review', 'review_editor', 'fact_check'] as const) {
      const instruction = buildExpertInstructions(role);
      assert.match(instruction, /正文面向最终读者.*材料审计报告/u);
      assert.match(instruction, /不自动变成文章开篇免责声明/u);
      assert.match(instruction, /不得捏造具体出处/u);
      assert.match(instruction, /争议、不确定性、数字口径和适用条件仍应就事说明/u);
      assert.match(instruction, /不能靠通用免责声明让它通过/u);
    }
  });
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
    assert.match(reader, /模拟读者.*即时感受/u);
    assert.match(reader, /点开.*划走.*读完.*转发/u);
    assert.match(buildExpertInstructions('fact_check'), /易错.*存疑[\s\S]*第一人称亲历叙事[\s\S]*不生成 C 编号/u);
    assert.match(editor, /写作工艺.*结构.*作者声音/u);
    assert.doesNotMatch(editor, /CTR|完读率/u);
    assert.match(publish, /读者价值.*全文承诺.*发布风险/u);
    assert.match(reader, /公众号.*今日头条.*知乎.*平台未知/u);
    assert.match(reader, /并行.*相互隔离/u);
    assert.match(reader, /禁止编辑术语.*修改建议/u);
    assert.match(reader, /不冒充真实用户调研/u);
    assert.match(reader, /不得升级为真实 reader_feedback/u);
    assert.doesNotMatch(reader, /提出可讨论的调整建议|每个判断引用/u);
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

  it('fact checks prioritize real errors and key facts, not ordinary-background paraphrase audits', () => {
    const instructions = buildExpertInstructions('fact_check');
    assert.match(instructions, /易错.*存疑.*时间.*人物身份.*事件.*数字/u);
    assert.match(instructions, /Brett.*20.*不.*单独/u);
    assert.match(instructions, /与材料一致.*不.*真实/u);
    assert.match(instructions, /不是写论文/u);
    assert.match(instructions, /没有引用不等于事实错误/u);
    assert.match(instructions, /不要求每条都联网或有论文/u);
    assert.match(instructions, /作者自述.*不要求公开证明/u);
    assert.match(instructions, /不可仅凭URL或主题相关就标SUPPORTED/u);
    assert.doesNotMatch(instructions, /关键事实.*必须.*外部证明/u);
    assert.match(instructions, /不.*逐字.*审计/u);
  });

  it("defers unsolicited title candidates in outline and draft without discarding an existing author title", () => {
    for (const role of ["outline", "draft"] as const) {
      const instruction = buildExpertInstructions(role);
      assert.match(instruction, /非用户明确要求.*不得.*拟标题.*候选/u, role);
      assert.match(instruction, /用户明确指定.*现有标题.*保留/u, role);
      assert.match(instruction, /后期.*title.*阶段/u, role);
    }
    assert.match(buildExpertInstructions('draft'), /已确认主题.*工作标题/u);
  });

  it('keeps illustration planning concise and optional when generation is unavailable', () => {
    const instruction = buildExpertInstructions('illustrator');
    assert.match(instruction, /1张封面.*1—2张正文图/u);
    assert.match(instruction, /直接复制.*Prompt/u);
    assert.match(instruction, /不要额外展开禁画清单/u);
    assert.match(instruction, /不.*再设确认关卡/u);
    assert.match(instruction, /查看当前稿件→导出文章/u);
    assert.match(instruction, /配图是可选项.*不阻挡/u);
    assert.match(instruction, /不声称图片成功/u);
  });
});
