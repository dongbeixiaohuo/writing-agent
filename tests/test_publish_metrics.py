from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path

from scripts.record_publish_metrics import record_publish_metrics


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def payload(**overrides: object) -> dict:
    value = {
        "platform": "公众号",
        "published_at": "2026-08-10T10:00:00+08:00",
        "observed_at": "2026-08-12T10:00:00+08:00",
        "observation_window": "发布后 48 小时",
        "traffic_sources": ["公众号会话", "朋友圈"],
        "cover_ref": "cover-v1.png",
        "metrics": {
            "impressions": 1000,
            "opens": 200,
            "complete_reads": 80,
            "shares": 12,
            "comments": 5,
            "saves": 20,
            "likes": 30,
            "new_followers": 4,
            "avg_read_seconds": 95,
        },
        "notes": "测试记录",
    }
    value.update(overrides)
    return value


class PublishMetricsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory()
        self.project_dir = Path(self.tempdir.name) / "articles" / "测试项目"
        self.project_dir.mkdir(parents=True)
        self.body = self.project_dir / "draft_v3_humanized.md"
        self.title = self.project_dir / "04_title.md"
        write(self.body, "# 已发布正文\n\n内容")
        write(
            self.title,
            """## 候选标题池

### G
- 标题：工资的一半，是你受的气折算的
- 公式：公式9（扎心直击型）

## 最终锁定
- 选择状态：已锁定
- 最终编号：G
- 最终标题：「工资的一半，是你受的气折算的」
""",
        )

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def test_records_append_only_version_bound_metrics(self) -> None:
        first = record_publish_metrics(
            self.project_dir,
            self.body.name,
            self.title.name,
            payload(),
            recorded_at="2026-08-12T10:05:00+08:00",
        )
        second = record_publish_metrics(
            self.project_dir,
            self.body.name,
            self.title.name,
            payload(observed_at="2026-08-13T10:00:00+08:00", observation_window="发布后 72 小时"),
            recorded_at="2026-08-13T10:05:00+08:00",
        )

        lines = (self.project_dir / "publication_metrics.jsonl").read_text(encoding="utf-8").splitlines()
        records = [json.loads(line) for line in lines]

        self.assertEqual(2, len(records))
        self.assertNotEqual(first["record_id"], second["record_id"])
        self.assertEqual(hashlib.sha256(self.body.read_bytes()).hexdigest(), first["artifacts"]["body_sha256"])
        self.assertEqual(hashlib.sha256(self.title.read_bytes()).hexdigest(), first["artifacts"]["title_sha256"])
        self.assertEqual(0.2, first["derived_metrics"]["open_rate"])
        self.assertEqual(0.4, first["derived_metrics"]["completion_rate"])

    def test_snapshots_creative_metadata_from_locked_artifacts(self) -> None:
        write(
            self.project_dir / "05c_opening_hook.md",
            "# 开头钩子（已锁定）\n\n> 选择：A - 暴击型（场景直击）\n",
        )
        write(
            self.project_dir / "04_share_map.md",
            "> 主导社交货币：展示清醒独立 + 安全地暗讽\n",
        )
        write(
            self.project_dir / "01_theme.md",
            """| 要素 | 内容 |
|---|---|
| **写作风格** | 记忆大师风格（碧树西风风） |
| **风格证据状态** | legacy_unverified |
| **发布平台** | 公众号 |
""",
        )

        record = record_publish_metrics(
            self.project_dir,
            self.body.name,
            self.title.name,
            payload(),
            recorded_at="2026-08-12T10:05:00+08:00",
        )

        creative = record["creative_metadata"]
        self.assertEqual("G", creative["title"]["selected_candidate"])
        self.assertEqual("公式9（扎心直击型）", creative["title"]["formula"])
        self.assertEqual("A", creative["opening"]["selected_variant"])
        self.assertEqual("展示清醒独立 + 安全地暗讽", creative["share"]["primary_motive"])
        self.assertEqual("记忆大师风格（碧树西风风）", creative["style"]["name"])
        self.assertEqual("legacy_unverified", creative["style"]["verification_status"])
        self.assertEqual("公众号", creative["platform"])
        self.assertEqual(
            hashlib.sha256((self.project_dir / "05c_opening_hook.md").read_bytes()).hexdigest(),
            creative["sources"]["opening"]["sha256"],
        )

    def test_creative_metadata_is_null_safe_for_legacy_projects(self) -> None:
        record = record_publish_metrics(
            self.project_dir,
            self.body.name,
            self.title.name,
            payload(),
            recorded_at="2026-08-12T10:05:00+08:00",
        )

        creative = record["creative_metadata"]
        self.assertEqual("G", creative["title"]["selected_candidate"])
        self.assertIsNone(creative["opening"]["selected_variant"])
        self.assertIsNone(creative["share"]["primary_motive"])
        self.assertIsNone(creative["style"]["name"])
        self.assertNotIn("opening", creative["sources"])

    def test_rejects_impossible_or_negative_metrics(self) -> None:
        with self.assertRaises(ValueError):
            record_publish_metrics(
                self.project_dir,
                self.body.name,
                self.title.name,
                payload(metrics={"impressions": 10, "opens": 11}),
            )

        with self.assertRaises(ValueError):
            record_publish_metrics(
                self.project_dir,
                self.body.name,
                self.title.name,
                payload(metrics={"impressions": 10, "opens": 5, "comments": -1}),
            )

        self.assertFalse((self.project_dir / "publication_metrics.jsonl").exists())

    def test_rejects_artifact_paths_outside_project(self) -> None:
        with self.assertRaises(ValueError):
            record_publish_metrics(
                self.project_dir,
                "../outside.md",
                self.title.name,
                payload(),
            )

    def test_rejects_naive_or_backwards_observation_times(self) -> None:
        with self.assertRaises(ValueError):
            record_publish_metrics(
                self.project_dir,
                self.body.name,
                self.title.name,
                payload(observed_at="2026-08-12T10:00:00"),
            )

        with self.assertRaises(ValueError):
            record_publish_metrics(
                self.project_dir,
                self.body.name,
                self.title.name,
                payload(observed_at="2026-08-09T10:00:00+08:00"),
            )


if __name__ == "__main__":
    unittest.main()
