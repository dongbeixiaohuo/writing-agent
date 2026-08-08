from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from scripts.validate_workflow import validate_repo


CONTRACT = {
    "workflow_version": "collab-v2",
    "legacy_aliases": {
        "02_cases.md": "02_scar_tissue.md",
        "04_empathy_map.md": "04_share_map.md",
    },
    "stages": [
        {"id": "3", "agent": "outline-architect", "outputs": ["03_outline.md"]},
        {"id": "5", "agent": "concretizer", "outputs": ["05_concrete_library.md"]},
    ],
}


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_valid_stage_artifact(project_dir: Path, file_name: str) -> None:
    if file_name == "01_theme.md":
        content = "| **写作风格** | 九边风 |\n\n> 风格确认状态：用户已确认\n"
    elif file_name == "02_evidence_ledger.json":
        content = json.dumps({"claims": [], "notes": "本阶段没有外部事实主张。"}, ensure_ascii=False)
    elif file_name == "04_title.md":
        content = "## 最终锁定\n- 选择状态：已锁定\n- 最终编号：A\n- 最终标题：「测试标题」\n"
    elif file_name == "05c_opening_hook.md":
        content = "# 开头钩子（已锁定）\n\n> 选择：A - 暴击型\n\n" + "这是用户确认后的开头正文。" * 10
    else:
        content = "ready"
    write(project_dir / file_name, content)


class ValidateWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)

        write(self.root / ".claude/workflows/collab_v2.json", json.dumps(CONTRACT, ensure_ascii=False))
        write(self.root / "claude-runtime/workflows/collab_v2.json", json.dumps(CONTRACT, ensure_ascii=False))
        write(self.root / ".claude/skills/workflow-producer/SKILL.md", "# workflow\n03_outline.md\n05_concrete_library.md\n")
        write(self.root / "claude-runtime/skills/workflow-producer/SKILL.md", "# workflow\n03_outline.md\n05_concrete_library.md\n")
        write(self.root / "README.md", "# readme\n")
        write(self.root / "articles/README.md", "# articles\n")
        write(self.root / "docs/WORKFLOW_QUICK_REFERENCE.md", "# quick reference\n")
        write(self.root / "docs/PROJECT_STRUCTURE.md", "# project structure\n")

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_rejects_legacy_artifacts_in_active_agents(self) -> None:
        write(
            self.root / ".claude/agents/outline-architect.md",
            "读取 02_cases.md\n输出 03_outline.md\n",
        )
        write(
            self.root / ".claude/agents/concretizer.md",
            "读取 04_share_map.md\n输出 05_concrete_library.md\n",
        )

        report = validate_repo(self.root, "active")

        self.assertTrue(report["errors"])
        self.assertTrue(any("02_cases.md" in issue.message for issue in report["errors"]))

    def test_allows_legacy_artifacts_under_articles_samples(self) -> None:
        write(
            self.root / ".claude/agents/outline-architect.md",
            "读取 01_theme.md\n输出 03_outline.md\n",
        )
        write(
            self.root / ".claude/agents/concretizer.md",
            "读取 04_share_map.md\n输出 05_concrete_library.md\n",
        )
        write(self.root / "articles/示例/03_outline.md", "历史说明：来源 02_cases.md\n")

        report = validate_repo(self.root, "all")

        self.assertFalse(report["errors"])
        self.assertTrue(report["warnings"])
        self.assertTrue(any("legacy" in issue.message for issue in report["warnings"]))

    def test_requires_v2_outputs_for_stage_agents(self) -> None:
        write(
            self.root / ".claude/agents/outline-architect.md",
            "这里只有旧说明，没有输出声明\n",
        )
        write(
            self.root / ".claude/agents/concretizer.md",
            "输出 05_concrete_library.md\n",
        )

        report = validate_repo(self.root, "active")

        self.assertTrue(any("03_outline.md" in issue.message for issue in report["errors"]))

    def test_can_validate_against_claude_runtime_assets(self) -> None:
        write(
            self.root / "claude-runtime/agents/outline-architect.md",
            "读取 01_theme.md\n输出 03_outline.md\n",
        )
        write(
            self.root / "claude-runtime/agents/concretizer.md",
            "读取 04_share_map.md\n输出 05_concrete_library.md\n",
        )

        report = validate_repo(self.root, "active", runtime_root=self.root / "claude-runtime")

        self.assertFalse(report["errors"])


class WorkflowStageGateTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.project_dir = self.root / "articles" / "测试项目"
        self.project_dir.mkdir(parents=True, exist_ok=True)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def _run_stage_check(self, contract: dict, mode: str) -> subprocess.CompletedProcess[str]:
        workflow_path = self.root / "collab_v2.json"
        workflow_path.write_text(json.dumps(contract, ensure_ascii=False), encoding="utf-8")
        script_path = Path(__file__).parents[1] / "claude-runtime" / "scripts" / "verify_required_files.py"
        return subprocess.run(
            [
                sys.executable,
                str(script_path),
                "--project-dir",
                str(self.project_dir),
                "--workflow",
                str(workflow_path),
                "--stage",
                "6",
                "--mode",
                mode,
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )

    def test_stage_check_reads_all_mode_b_inputs_from_workflow_json(self) -> None:
        contract = {
            "stages": [
                {
                    "id": "6",
                    "inputs": ["01_theme.md", "02_evidence_ledger.json", "03_outline.md"],
                }
            ]
        }
        for file_name in contract["stages"][0]["inputs"]:
            write_valid_stage_artifact(self.project_dir, file_name)

        result = self._run_stage_check(contract, "B")

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn('"03_outline.md"', result.stdout)

    def test_stage_check_applies_mode_a_minimal_input_override(self) -> None:
        contract = {
            "modes": {
                "A": {
                    "stage_sequence": ["1", "6", "7"],
                    "stage_overrides": {"6": {"inputs": ["01_theme.md"]}},
                }
            },
            "stages": [
                {
                    "id": "6",
                    "inputs": ["01_theme.md", "02_evidence_ledger.json", "03_outline.md"],
                }
            ],
        }
        write_valid_stage_artifact(self.project_dir, "01_theme.md")

        result = self._run_stage_check(contract, "A")

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertNotIn("02_evidence_ledger.json", result.stdout)

    def test_stage_check_rejects_placeholder_opening_and_invalid_evidence_ledger(self) -> None:
        contract = {
            "stages": [
                {
                    "id": "6",
                    "inputs": ["02_evidence_ledger.json", "05c_opening_hook.md"],
                }
            ]
        }
        write(self.project_dir / "02_evidence_ledger.json", "ready")
        write(self.project_dir / "05c_opening_hook.md", "ready")

        result = self._run_stage_check(contract, "B")

        self.assertEqual(1, result.returncode, result.stdout + result.stderr)
        self.assertIn("invalid_json", result.stdout)
        self.assertIn("unlocked_opening", result.stdout)


class WorkflowRuntimeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        runtime = Path(__file__).parents[1] / "claude-runtime"
        cls.runtime = runtime
        cls.contract = json.loads((runtime / "workflows" / "collab_v2.json").read_text(encoding="utf-8"))
        cls.director = (runtime / "skills" / "workflow-producer" / "SKILL.md").read_text(encoding="utf-8")
        cls.executor = (runtime / "agents" / "writing-executor.md").read_text(encoding="utf-8")
        cls.article_illustrator = (runtime / "agents" / "article-illustrator.md").read_text(encoding="utf-8")
        cls.html_exporter = (runtime / "agents" / "html-exporter.md").read_text(encoding="utf-8")
        cls.edit_learner = (runtime / "agents" / "edit-diff-learner.md").read_text(encoding="utf-8")
        cls.memory_loader = (runtime / "agents" / "memory-loader.md").read_text(encoding="utf-8")
        cls.humanizer = (runtime / "agents" / "humanizer.md").read_text(encoding="utf-8")
        cls.fact_checker = (runtime / "agents" / "fact-checker.md").read_text(encoding="utf-8")
        cls.title_designer = (runtime / "agents" / "title-designer.md").read_text(encoding="utf-8")
        cls.opening_tournament = (runtime / "agents" / "opening-tournament.md").read_text(encoding="utf-8")

    def test_director_trigger_scope_excludes_simple_edits_and_accepts_explicit_mode(self) -> None:
        self.assertIn("需要多阶段产物的中文长文", self.director)
        self.assertIn("用户已明确选择 A/B/C", self.director)
        self.assertIn("简单润色、校对、翻译不触发", self.director)
        self.assertNotIn("所有写作请求的唯一入口点", self.director)
        self.assertNotIn("无论用户说什么，只要涉及写作", self.director)

    def test_subagent_metadata_defers_order_to_director(self) -> None:
        self.assertIn("由工作流导演调度", self.memory_loader)
        self.assertIn("由工作流导演调度", self.humanizer)
        self.assertNotIn("工作流最前面", self.memory_loader)
        self.assertNotIn("显式询问调用", self.humanizer)

    def test_mode_a_declares_minimal_stage_6_contract(self) -> None:
        mode_a = self.contract["modes"]["A"]

        self.assertEqual(["1", "6", "7"], mode_a["stage_sequence"])
        self.assertEqual(["01_theme.md"], mode_a["stage_overrides"]["6"]["inputs"])
        self.assertIn("--stage 6 --mode A", self.director)
        self.assertIn("工作流模式：A", self.executor)

    def test_mode_a_writing_rules_do_not_require_missing_collaboration_artifacts(self) -> None:
        self.assertIn("模式 A 按 `01_theme.md` 确定主线", self.executor)
        self.assertIn("模式 A 只使用简报中的用户素材", self.executor)
        self.assertIn("模式 A 不要求 `evidence_id`", self.executor)

    def test_mode_b_stage_6_gate_is_sourced_from_workflow_json(self) -> None:
        stage_6 = next(stage for stage in self.contract["stages"] if stage["id"] == "6")
        self.assertEqual(
            [
                "01_theme.md",
                "01b_position.md",
                "02_scar_tissue.md",
                "02_evidence_ledger.json",
                "03_outline.md",
                "04_title.md",
                "04_share_map.md",
                "05_concrete_library.md",
                "05c_opening_hook.md",
            ],
            stage_6["inputs"],
        )
        self.assertIn("--stage 6 --mode B", self.director)
        self.assertIn("--stage 6 --mode B", self.executor)

    def test_tail_automatic_transitions_are_machine_readable(self) -> None:
        transitions = {
            (item["from"], item["to"])
            for item in self.contract["interaction_policy"]["automatic_transitions"]
        }

        self.assertEqual(
            {
                ("9", "10"),
                ("10", "10.5"),
                ("11", "12"),
                ("12", "12.5"),
                ("12.5", "13"),
            },
            transitions,
        )
        self.assertEqual("13", self.contract["interaction_policy"]["terminal_stage"])

    def test_html_theme_is_selected_once_by_director(self) -> None:
        self.assertIn("禁止再次询问", self.html_exporter)
        self.assertNotIn("这是一个两回合 Subagent", self.html_exporter)
        self.assertIn("导演已确认版式", self.html_exporter)

    def test_node_tools_have_plugin_data_and_clone_execution_paths(self) -> None:
        self.assertIn("${CLAUDE_PLUGIN_DATA}/runtime/scripts/generate_image.ts", self.article_illustrator)
        self.assertIn("npx tsx scripts/generate_image.ts", self.article_illustrator)
        self.assertIn("${CLAUDE_PLUGIN_DATA}/runtime/scripts/export_markdown_to_html.ts", self.html_exporter)
        self.assertIn("npx tsx scripts/export_markdown_to_html.ts", self.html_exporter)

    def test_stage_13_always_writes_episode_even_without_diff(self) -> None:
        self.assertIn("Stage 13 始终执行", self.director)
        self.assertIn("无可学习差异", self.edit_learner)
        self.assertNotIn("需要至少经历过一轮修改才有意义", self.edit_learner)

    def test_auto_clean_hook_cannot_run_on_humanizer_stop(self) -> None:
        hooks = json.loads((self.runtime / "hooks" / "hooks.json").read_text(encoding="utf-8"))
        subagent_hook = hooks["hooks"]["SubagentStop"][0]

        self.assertNotIn("humanizer", subagent_hook["matcher"])
        self.assertEqual(30, subagent_hook["hooks"][0]["timeout"])
        self.assertIn('auto_clean_hook.py" --project "[项目名]"', self.director)

    def test_humanizer_preserves_the_verified_truth_boundary(self) -> None:
        self.assertIn("01_theme.md", self.humanizer)
        self.assertIn("02_evidence_ledger.json", self.humanizer)
        self.assertIn("无（用户确认）", self.humanizer)
        self.assertIn("禁止新增第一人称亲历", self.humanizer)
        self.assertIn("禁止补写", self.humanizer)

    def test_fact_checker_records_a_hash_bound_manifest_result(self) -> None:
        self.assertIn("update_run_manifest.py", self.fact_checker)
        self.assertIn("--fact-check-status", self.fact_checker)
        self.assertIn("fact_checked_body_sha256", self.fact_checker)

    def test_candidate_title_gate_is_presence_only_but_final_gate_is_semantic(self) -> None:
        self.assertIn("--presence-only", self.title_designer)
        self.assertGreaterEqual(self.title_designer.count("--required 04_title.md"), 2)

    def test_opening_template_records_the_selected_option(self) -> None:
        self.assertIn("赛马获胜方案：[A/B/C/自定义]", self.opening_tournament)


if __name__ == "__main__":
    unittest.main()
