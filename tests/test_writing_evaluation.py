import csv
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "evaluations" / "writing_blind_review.py"
SPEC = importlib.util.spec_from_file_location("writing_blind_review", MODULE_PATH)
review = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(review)
CASES = ROOT / "evaluations" / "cases" / "writing_quality_cases.json"


class WritingEvaluationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.baseline, self.candidate = self.root / "baseline.md", self.root / "candidate.md"
        self.baseline.write_text("> 版本：baseline\n> 来源路径：secret/old.md\n# 实际标题\n\n[引用](https://example.test)\n", encoding="utf-8")
        self.candidate.write_text("> 版本：candidate\n# 实际标题\n\n候选正文。\n", encoding="utf-8")
        self.packet, self.key = self.root / "packet", self.root / "secret" / "key.json"

    def tearDown(self): self.temp.cleanup()

    def _prepare(self): review.prepare_pair(self.baseline, self.candidate, self.packet, self.key, seed=7)

    def _row(self, case_id="pair-001"):
        row = {field: "3" for field in review.SCORE_FIELDS}
        row.update({"case_id": case_id, "preferred": "A", "major_fact_error_a": "no", "major_fact_error_b": "yes"})
        return row

    def _scores(self, rows):
        path = self.packet / "scores.csv"
        with path.open("w", encoding="utf-8", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=review.SCORE_FIELDS); writer.writeheader(); writer.writerows(rows)
        return path

    def test_prepare_hides_identifying_metadata_and_keeps_title_and_citation(self):
        self._prepare()
        packet = (self.packet / "packet.json").read_text(encoding="utf-8")
        body = "\n".join(path.read_text(encoding="utf-8") for path in self.packet.glob("pair-001-*.md"))
        self.assertNotIn("baseline", packet); self.assertNotIn("candidate", packet)
        self.assertNotIn("来源路径", body); self.assertIn("# 实际标题", body); self.assertIn("https://example.test", body)
        key = json.loads(self.key.read_text(encoding="utf-8"))
        self.assertEqual(7, key["seed"]); self.assertIn("input_sha256", key["cases"]["pair-001"])

    def test_prepare_rejects_missing_input_external_key_and_existing_key(self):
        with self.assertRaisesRegex(review.ReviewError, "缺少可用正文"):
            review.prepare_pair(self.root / "missing", self.candidate, self.packet, self.key, 1)
        with self.assertRaisesRegex(review.ReviewError, "目录之外"):
            review.prepare_pair(self.baseline, self.candidate, self.packet, self.packet / "key.json", 1)
        self.key.parent.mkdir(parents=True); self.key.write_text("old", encoding="utf-8")
        with self.assertRaisesRegex(review.ReviewError, "拒绝覆盖"):
            review.prepare_pair(self.baseline, self.candidate, self.packet, self.key, 1)

    def test_manifest_path_cannot_escape_project(self):
        project, outside = self.root / "project", self.root / "outside.md"
        project.mkdir(); outside.write_text("# 外部", encoding="utf-8")
        (project / "run_manifest.json").write_text(json.dumps({"latest_body_file": "../outside.md"}), encoding="utf-8")
        with self.assertRaisesRegex(review.ReviewError, "越出项目"):
            review.resolve_body(project)

    def test_prepare_suite_writes_twelve_pairs_and_key_metadata(self):
        base, candidate = self.root / "base", self.root / "candidate"
        payload = json.loads(CASES.read_text(encoding="utf-8"))
        for case in payload["cases"]:
            for root, text in ((base, "基线"), (candidate, "候选")):
                root.mkdir(exist_ok=True); (root / f"{case['id']}.md").write_text(f"# {case['id']}\n\n{text}", encoding="utf-8")
        review.prepare_suite(base, candidate, CASES, self.packet, self.key, seed=11, model="local", prompt_version="p2")
        self.assertEqual(24, len(list(self.packet.glob("*.md"))) - 1)  # rubric excluded
        with (self.packet / "scores.csv").open(encoding="utf-8", newline="") as handle:
            rows = list(csv.DictReader(handle))
        key = json.loads(self.key.read_text(encoding="utf-8"))
        self.assertEqual(12, len(rows)); self.assertEqual(12, len(key["cases"])); self.assertEqual("local", key["model"])
        briefs = json.loads((self.packet / "briefs.json").read_text(encoding="utf-8"))
        self.assertEqual(payload, briefs)

    def test_blinding_preserves_quoted_content_after_body_begins(self):
        article = "# 题目\n> 版本：old\n\n文章分析三种表达。\n\n> 风格：它是一个原始引用，应当保留。\n"
        blinded = review.blind_text(article)
        self.assertNotIn("版本：old", blinded)
        self.assertIn("> 风格：它是一个原始引用", blinded)

    def test_suite_rejects_path_like_ids_before_writing(self):
        cases = self.root / "bad-cases.json"
        cases.write_text(json.dumps({"cases": [{"id": "../outside"}]}), encoding="utf-8")
        with self.assertRaisesRegex(review.ReviewError, "案例 id"):
            review.prepare_suite(self.root, self.root, cases, self.packet, self.key)
        self.assertFalse(self.packet.exists())

    def test_prepare_suite_missing_article_writes_nothing(self):
        base, candidate = self.root / "base", self.root / "candidate"
        base.mkdir(); candidate.mkdir()
        (base / "comment-01.md").write_text("# x", encoding="utf-8")
        (candidate / "comment-01.md").write_text("# y", encoding="utf-8")
        with self.assertRaisesRegex(review.ReviewError, "缺少案例"):
            review.prepare_suite(base, candidate, CASES, self.packet, self.key, seed=1)
        self.assertFalse(self.packet.exists()); self.assertFalse(self.key.exists())

    def test_summarize_maps_scores_and_rejects_bad_mapping_or_output_overwrite(self):
        self._prepare()
        result = review.summarize(self._scores([self._row()]), self.key, self.root / "summary.json")
        self.assertEqual(1, result["reviewed_pairs"]); self.assertIn("不宣称显著性、因果", result["interpretation"])
        with self.assertRaisesRegex(review.ReviewError, "不得覆盖"):
            review.summarize(self.packet / "scores.csv", self.key, self.packet / "scores.csv")
        key = json.loads(self.key.read_text(encoding="utf-8")); key["cases"]["pair-001"]["A"] = "wrong"
        self.key.write_text(json.dumps(key), encoding="utf-8")
        with self.assertRaisesRegex(review.ReviewError, "必须恰为"):
            review.summarize(self.packet / "scores.csv", self.key, self.root / "other.json")

    def test_summarize_rejects_duplicate_illegal_and_missing_scores(self):
        self._prepare(); row = self._row()
        with self.assertRaisesRegex(review.ReviewError, "重复"):
            review.summarize(self._scores([row, row.copy()]), self.key, self.root / "summary.json")
        bad = self._row(); bad["a_structure"] = "6"
        with self.assertRaisesRegex(review.ReviewError, "1–5"):
            review.summarize(self._scores([bad]), self.key, self.root / "summary.json")
        with self.assertRaisesRegex(review.ReviewError, "缺少评分"):
            review.summarize(self._scores([]), self.key, self.root / "summary.json")

    def test_cases_are_twelve_complete_synthetic_fixtures(self):
        payload = json.loads(CASES.read_text(encoding="utf-8")); cases = payload["cases"]
        self.assertIn("合成评测夹具", payload["fixture_notice"]); self.assertEqual(12, len(cases))
        for genre in ("争议评论", "解释分析", "叙事观察", "实用经验"):
            self.assertEqual(3, sum(case["genre"] == genre for case in cases))
        for case in cases:
            for field in ("materials", "target_reader", "target_length", "constraints", "observation_points", "evidence_status"):
                self.assertTrue(case[field])
        self.assertTrue(any("证据不足" in case["evidence_status"] for case in cases))


if __name__ == "__main__": unittest.main()
