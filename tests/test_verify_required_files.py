from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from scripts.verify_required_files import find_file_issues, required_files_for_stage, verify_required_files


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def valid_evidence_ledger(
    *,
    duplicate: bool = False,
    research_requirement: str | None = None,
    research_attempts: list[dict] | None = None,
) -> str:
    claim = {
        "evidence_id": "E001",
        "claim_type": "number",
        "claim_text": "一项调查给出了可核查的数据。",
        "source_title": "示例报告",
        "source_url": "https://example.com/report",
        "source_publisher": "示例机构",
        "source_quote": "报告中的原始摘录。",
        "accessed_at": "2026-08-08",
        "reliability": "high",
        "use_boundary": "只能用于说明示例范围。",
        "verification_status": "collected",
    }
    claims = [claim, {**claim}] if duplicate else [claim]
    ledger = {"claims": claims, "notes": "测试账本"}
    if research_requirement is not None:
        ledger["research_requirement"] = research_requirement
    if research_attempts is not None:
        ledger["research_attempts"] = research_attempts
    return json.dumps(ledger, ensure_ascii=False)


class VerifyRequiredFilesTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.project_dir = Path(self.tempdir.name) / "articles" / "测试项目"
        self.project_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_verify_required_files_passes_when_all_files_exist_and_nonempty(self) -> None:
        write(self.project_dir / "04_share_map.md", "# share map")
        write(self.project_dir / "05_concrete_library.md", "# concrete library")
        write(
            self.project_dir / "05c_opening_hook.md",
            "# 开头钩子（已锁定）\n\n> 选择：A - 暴击型\n\n" + "这是经用户选择的真实开头内容。" * 8,
        )

        issues = find_file_issues(
            self.project_dir,
            ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
        )

        self.assertEqual([], issues)
        self.assertTrue(
            verify_required_files(
                self.project_dir,
                ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
            )
        )

    def test_verify_required_files_reports_missing_and_empty_files(self) -> None:
        write(self.project_dir / "04_share_map.md", "# share map")
        write(self.project_dir / "05_concrete_library.md", "   \n")

        issues = find_file_issues(
            self.project_dir,
            ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
        )

        self.assertEqual(
            [
                {"file": "05_concrete_library.md", "reason": "empty"},
                {"file": "05c_opening_hook.md", "reason": "missing"},
            ],
            issues,
        )
        self.assertFalse(
            verify_required_files(
                self.project_dir,
                ["04_share_map.md", "05_concrete_library.md", "05c_opening_hook.md"],
            )
        )

    def test_verify_required_files_rejects_unlocked_title_file(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题候选与锁定结果

## 最终锁定
- **选择状态**：待定
- **最终编号**：待定
- **最终标题**：待定
""",
        )

        issues = find_file_issues(self.project_dir, ["04_title.md"])

        self.assertEqual(
            [{"file": "04_title.md", "reason": "unlocked_title"}],
            issues,
        )
        self.assertFalse(verify_required_files(self.project_dir, ["04_title.md"]))

    def test_verify_required_files_accepts_locked_title_file(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题确认

## 最终锁定
- 选择状态：已锁定
- 最终编号：A
- 最终标题：「你的大脑\"默认设置\"是什么时候的？答案很残忍」
""",
        )

        issues = find_file_issues(self.project_dir, ["04_title.md"])

        self.assertEqual([], issues)
        self.assertTrue(verify_required_files(self.project_dir, ["04_title.md"]))

    def test_title_text_without_an_explicit_lock_is_rejected(self) -> None:
        write(
            self.project_dir / "04_title.md",
            "## 最终标题\n\n**「看起来像最终标题，但用户没有锁定」**\n",
        )

        self.assertEqual(
            [{"file": "04_title.md", "reason": "unlocked_title"}],
            find_file_issues(self.project_dir, ["04_title.md"]),
        )

    def test_locked_title_rejects_a_decorated_pending_placeholder(self) -> None:
        write(
            self.project_dir / "04_title.md",
            "## 最终锁定\n- 选择状态：已锁定\n- 最终编号：A\n- 最终标题：待定（稍后补）\n",
        )

        self.assertEqual(
            [{"file": "04_title.md", "reason": "unlocked_title"}],
            find_file_issues(self.project_dir, ["04_title.md"]),
        )

    def test_presence_only_accepts_a_title_candidate_pool(self) -> None:
        write(
            self.project_dir / "04_title.md",
            "# 标题候选\n\n## 最终锁定\n- 选择状态：待定\n- 最终标题：待定\n",
        )

        self.assertEqual(
            [],
            find_file_issues(self.project_dir, ["04_title.md"], presence_only=True),
        )

    def test_new_title_template_requires_distribution_copy_selection(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题候选

## 平台分发文案候选（3 条）
- S1：候选一
- S2：候选二
- S3：候选三

## 最终锁定
- 选择状态：已锁定
- 最终编号：A
- 最终标题：「测试标题」
- 分发文案选择：待定
- 最终分发文案：待定
""",
        )

        self.assertEqual(
            [{"file": "04_title.md", "reason": "unlocked_distribution_copy"}],
            find_file_issues(self.project_dir, ["04_title.md"]),
        )

    def test_new_title_template_accepts_locked_distribution_copy(self) -> None:
        write(
            self.project_dir / "04_title.md",
            """# 标题候选

## 平台分发文案候选（3 条）
- S1：候选一
- S2：候选二
- S3：候选三

## 最终锁定
- 选择状态：已锁定
- 最终编号：A
- 最终标题：「测试标题」
- 分发文案选择：S1
- 最终分发文案：候选一
""",
        )

        self.assertEqual([], find_file_issues(self.project_dir, ["04_title.md"]))

    def test_theme_requires_an_explicitly_confirmed_style(self) -> None:
        write(
            self.project_dir / "01_theme.md",
            "| **写作风格** | 九边风 |\n\n## 备注\n由系统自动选择。\n",
        )

        self.assertEqual(
            [{"file": "01_theme.md", "reason": "unconfirmed_style"}],
            find_file_issues(self.project_dir, ["01_theme.md"]),
        )

    def test_theme_accepts_legacy_explicit_confirmation_wording(self) -> None:
        write(
            self.project_dir / "01_theme.md",
            "| **写作风格** | 九边风 |\n\n- 用户已显式确认风格选择（九边风）。\n",
        )

        self.assertEqual([], find_file_issues(self.project_dir, ["01_theme.md"]))

    def test_opening_requires_lock_choice_and_substantive_content(self) -> None:
        write(self.project_dir / "05c_opening_hook.md", "# opening hook\n\n随便一段。\n")

        self.assertEqual(
            [{"file": "05c_opening_hook.md", "reason": "unlocked_opening"}],
            find_file_issues(self.project_dir, ["05c_opening_hook.md"]),
        )

    def test_evidence_ledger_must_be_valid_json(self) -> None:
        write(self.project_dir / "02_evidence_ledger.json", '{"claims": [}')

        self.assertEqual(
            [{"file": "02_evidence_ledger.json", "reason": "invalid_json"}],
            find_file_issues(self.project_dir, ["02_evidence_ledger.json"]),
        )

    def test_evidence_ledger_rejects_duplicate_evidence_ids(self) -> None:
        write(self.project_dir / "02_evidence_ledger.json", valid_evidence_ledger(duplicate=True))

        self.assertEqual(
            [{"file": "02_evidence_ledger.json", "reason": "duplicate_evidence_id"}],
            find_file_issues(self.project_dir, ["02_evidence_ledger.json"]),
        )

    def test_evidence_ledger_accepts_complete_claims(self) -> None:
        write(self.project_dir / "02_evidence_ledger.json", valid_evidence_ledger())

        self.assertEqual([], find_file_issues(self.project_dir, ["02_evidence_ledger.json"]))

    def test_evidence_ledger_requires_attempt_log_when_external_research_is_required(self) -> None:
        write(
            self.project_dir / "02_evidence_ledger.json",
            valid_evidence_ledger(research_requirement="required", research_attempts=[]),
        )

        self.assertEqual(
            [{"file": "02_evidence_ledger.json", "reason": "invalid_evidence_ledger"}],
            find_file_issues(self.project_dir, ["02_evidence_ledger.json"]),
        )

    def test_evidence_ledger_accepts_structured_external_research_attempts(self) -> None:
        write(
            self.project_dir / "02_evidence_ledger.json",
            valid_evidence_ledger(
                research_requirement="required",
                research_attempts=[
                    {
                        "target_claim": "核查报告中的样本量",
                        "query": "示例报告 样本量",
                        "outcome": "found",
                        "notes": "找到发布方原始报告。",
                    }
                ],
            ),
        )

        self.assertEqual([], find_file_issues(self.project_dir, ["02_evidence_ledger.json"]))

    def test_stage_inputs_resolve_latest_body_file_from_manifest(self) -> None:
        workflow_path = Path(self.tempdir.name) / "collab_v2.json"
        write(
            workflow_path,
            json.dumps(
                {
                    "stages": [
                        {
                            "id": "10.5",
                            "inputs": ["02_evidence_ledger.json", "[latest_body_file]"],
                        }
                    ]
                },
                ensure_ascii=False,
            ),
        )
        write(self.project_dir / "draft_v3_humanized.md", "# 正文")
        write(
            self.project_dir / "run_manifest.json",
            json.dumps({"latest_body_file": "draft_v3_humanized.md"}, ensure_ascii=False),
        )

        required = required_files_for_stage(
            workflow_path,
            "10.5",
            "B",
            project_dir=self.project_dir,
        )

        self.assertEqual(["02_evidence_ledger.json", "draft_v3_humanized.md"], required)

    def test_stage_inputs_reject_unsafe_dynamic_manifest_path(self) -> None:
        workflow_path = Path(self.tempdir.name) / "collab_v2.json"
        write(
            workflow_path,
            json.dumps(
                {"stages": [{"id": "10.5", "inputs": ["[latest_body_file]"]}]},
                ensure_ascii=False,
            ),
        )
        write(
            self.project_dir / "run_manifest.json",
            json.dumps({"latest_body_file": "../outside.md"}, ensure_ascii=False),
        )

        with self.assertRaises(ValueError):
            required_files_for_stage(
                workflow_path,
                "10.5",
                "B",
                project_dir=self.project_dir,
            )



if __name__ == "__main__":
    unittest.main()
