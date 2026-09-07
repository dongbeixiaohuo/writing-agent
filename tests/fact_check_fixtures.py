"""Real input bindings shared by publication-gate regression tests."""
import json
from pathlib import Path

from scripts.fact_check_gate import SCHEMA, snapshot_inputs
from scripts.update_run_manifest import update_run_manifest


def write_claims(project: Path, body: str, title: str = "04_title.md", claims: list | None = None) -> dict:
    ledger = project / "02_evidence_ledger.json"
    if not ledger.exists():
        ledger.write_text(json.dumps({"claims": [], "notes": "测试稿不引用外部事实"}), encoding="utf-8")
    snapshot = snapshot_inputs(project, body, title)
    payload = {"schema_version": SCHEMA, "snapshot_id": snapshot["snapshot_id"],
               "body_file": body, "title_file": title,
               "coverage": {"body": True, "title": True, "distribution_copy": True},
               "claims": claims or [], "no_factual_claims_reason": "全文为作者感受，未引入可核查事实；分发文案不适用。"}
    (project / "fact_claims.json").write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    return payload


def approve(project: Path, body: str, title: str = "04_title.md") -> dict:
    write_claims(project, body, title)
    return update_run_manifest(project, body, title_file=title,
                               fact_claims_file="fact_claims.json", fact_check_report_file="fact_check_report.md")
