"""Snapshot fact-check inputs and validate publication against the actual claims."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import tempfile
import uuid
from datetime import datetime
from pathlib import Path

SCHEMA = "fact-check-v2"
SNAPSHOT_FILE = "fact_check_snapshot.json"
CLAIM_TYPES = {"number", "date", "person", "company", "policy", "report", "event", "link", "strong_assertion", "other"}
CLAIM_STATUSES = {"SUPPORTED", "UNSUPPORTED", "CONTRADICTED", "BROKEN_LINK", "NEEDS_USER_SOURCE"}


def project_file(project_dir: Path, name: str, *, must_exist: bool = True) -> Path:
    if not isinstance(name, str) or not name.strip() or Path(name).is_absolute():
        raise ValueError("核查文件必须是项目内的相对路径")
    root = project_dir.resolve()
    path = (root / name).resolve()
    if path == root or not path.is_relative_to(root):
        raise ValueError("核查文件不得越出项目目录")
    if must_exist and not path.is_file():
        raise ValueError(f"核查文件不存在: {name}")
    return path


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_object(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"{path.name} 顶层必须是对象")
    return value


def atomic_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def snapshot_inputs(project_dir: Path, body_file: str, title_file: str = "04_title.md",
                    ledger_file: str = "02_evidence_ledger.json") -> dict:
    paths = [project_file(project_dir, name) for name in (body_file, title_file, ledger_file)]
    snapshot_path = project_file(project_dir, SNAPSHOT_FILE, must_exist=False)
    if len(set(paths)) != 3 or snapshot_path in paths:
        raise ValueError("正文、标题、账本和快照必须是不同文件")
    snapshot = {"schema_version": SCHEMA, "snapshot_id": str(uuid.uuid4()),
                "created_at": datetime.now().astimezone().isoformat(timespec="seconds")}
    for field, name in (("body", body_file), ("title", title_file), ("ledger", ledger_file)):
        path = project_file(project_dir, name)
        snapshot[f"{field}_file"] = path.relative_to(project_dir.resolve()).as_posix()
        snapshot[f"{field}_sha256"] = sha256(path)
    atomic_text(snapshot_path, json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n")
    return snapshot


def assess_claims(project_dir: Path, body_file: str, title_file: str, claims_file: str) -> dict:
    snapshot_path = project_file(project_dir, SNAPSHOT_FILE)
    snapshot = read_object(snapshot_path)
    if snapshot.get("schema_version") != SCHEMA or not snapshot.get("snapshot_id"):
        raise ValueError("缺少本轮事实核查输入快照，请重新核查")
    for field in ("body", "title", "ledger"):
        path = project_file(project_dir, snapshot.get(f"{field}_file"))
        if sha256(path) != snapshot.get(f"{field}_sha256"):
            raise ValueError(f"核查期间 {field} 已变化，请重新创建快照并核查")
    if project_file(project_dir, body_file) != project_file(project_dir, snapshot["body_file"]):
        raise ValueError("核查快照对应另一份正文")
    if project_file(project_dir, title_file) != project_file(project_dir, snapshot["title_file"]):
        raise ValueError("核查快照对应另一份标题")

    # Imports stay local so this module also works as a direct plugin CLI.
    from scripts.verify_required_files import title_file_is_locked, distribution_copy_is_locked_if_declared, evidence_ledger_issue
    title = project_file(project_dir, title_file).read_text(encoding="utf-8")
    if not title_file_is_locked(title) or not distribution_copy_is_locked_if_declared(title):
        raise ValueError("交付前必须锁定最终标题和平台分发文案")
    ledger_path = project_file(project_dir, snapshot["ledger_file"])
    if evidence_ledger_issue(ledger_path.read_text(encoding="utf-8")):
        raise ValueError("证据账本未通过语义校验")
    evidence_ids = {item["evidence_id"] for item in read_object(ledger_path)["claims"]}
    claims_path = project_file(project_dir, claims_file)
    payload = read_object(claims_path)
    if payload.get("schema_version") != SCHEMA or payload.get("snapshot_id") != snapshot["snapshot_id"]:
        raise ValueError("事实清单未绑定本轮输入快照")
    for field in ("body", "title"):
        if payload.get(f"{field}_file") != snapshot[f"{field}_file"]:
            raise ValueError(f"事实清单的 {field}_file 与快照不一致")
    coverage = payload.get("coverage")
    if not isinstance(coverage, dict) or any(coverage.get(key) is not True for key in ("body", "title", "distribution_copy")):
        raise ValueError("必须核查全文、最终标题和分发文案，不能只抽查几条数字")
    claims = payload.get("claims")
    if not isinstance(claims, list):
        raise ValueError("事实清单的 claims 必须是数组")
    if not claims:
        reason = payload.get("no_factual_claims_reason")
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("空事实清单必须说明全文没有可核查事实的原因")
    seen = set()
    blockers = []
    for claim in claims:
        if not isinstance(claim, dict):
            raise ValueError("每条事实核查必须是对象")
        for key in ("claim_id", "claim_text", "claim_type", "location", "status", "risk", "support_scope", "evidence_summary", "recommended_action"):
            if not isinstance(claim.get(key), str) or not claim[key].strip():
                raise ValueError(f"事实清单缺少有效字段: {key}")
        claim_id = claim["claim_id"]
        if not re.fullmatch(r"C\d{3,}", claim_id) or claim_id in seen:
            raise ValueError("claim_id 必须有效且唯一")
        seen.add(claim_id)
        if claim["claim_type"] not in CLAIM_TYPES or claim["status"] not in CLAIM_STATUSES:
            raise ValueError("未知事实类型或核查状态")
        if claim["risk"] not in {"red", "yellow", "green"} or claim["support_scope"] not in {"full", "partial", "none"}:
            raise ValueError("未知风险或证据支持范围")
        evidence_id = claim.get("matched_evidence_id")
        if evidence_id is not None and (not isinstance(evidence_id, str) or evidence_id not in evidence_ids):
            raise ValueError("matched_evidence_id 必须对应账本或为 JSON null")
        if claim["status"] == "SUPPORTED" and evidence_id is None:
            reference = claim.get("source_reference")
            if not isinstance(reference, str) or not reference.strip():
                raise ValueError("SUPPORTED 必须提供账本证据或独立核查的来源定位")
        if claim["status"] != "SUPPORTED" or claim["risk"] == "red" or claim["support_scope"] != "full":
            blockers.append(claim_id)
    return {"status": "blocked" if blockers else "passed", "blockers": blockers,
            "claims": claims, "snapshot": snapshot, "claims_sha256": sha256(claims_path),
            "snapshot_sha256": sha256(snapshot_path)}


def render_report(assessment: dict) -> str:
    snapshot = assessment["snapshot"]
    lines = ["# 事实核查报告", "", f"- 核查状态：{assessment['status']}",
             f"- 正文：{snapshot['body_file']}", f"- 标题：{snapshot['title_file']}",
             f"- 输入快照：{snapshot['snapshot_id']}", f"- 阻断问题：{len(assessment['blockers'])}",
             "", "结论由脚本根据事实清单计算；无法验证的事实不得按黄色警告放行。", ""]
    for claim in assessment["claims"]:
        lines += [f"## {claim['claim_id']} · {claim['status']} · {claim['support_scope']}",
                  f"- 原文：{claim['claim_text']}", f"- 位置：{claim['location']}",
                  f"- 依据：{claim['evidence_summary']}", f"- 建议：{claim['recommended_action']}", ""]
    return "\n".join(lines) + "\n"


def publication_passed(project_dir: Path, body_file: str | None = None) -> bool:
    try:
        manifest = read_object(project_file(project_dir, "run_manifest.json"))
        body = body_file or manifest.get("latest_body_file")
        if manifest.get("fact_check_status") != "passed" or manifest.get("fact_check_schema") != SCHEMA:
            return False
        for field in ("latest_body_file", "clean_source_file", "fact_checked_body_file"):
            if project_file(project_dir, manifest.get(field)) != project_file(project_dir, body):
                return False
        assessment = assess_claims(project_dir, body, manifest.get("fact_checked_title_file"), manifest.get("latest_fact_claims_file"))
        if assessment["status"] != "passed":
            return False
        report = project_file(project_dir, manifest.get("latest_fact_check_report"))
        expected = {"fact_checked_body_sha256": assessment["snapshot"]["body_sha256"],
                    "fact_checked_title_sha256": assessment["snapshot"]["title_sha256"],
                    "fact_checked_claims_sha256": assessment["claims_sha256"],
                    "fact_checked_snapshot_sha256": assessment["snapshot_sha256"],
                    "fact_checked_report_sha256": sha256(report)}
        return all(manifest.get(key) == value for key, value in expected.items())
    except (OSError, ValueError, TypeError, KeyError):
        return False


def main() -> int:
    import sys
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from scripts.claude_runtime_paths import workspace_articles_dir
    parser = argparse.ArgumentParser(description="事实核查输入快照与交付校验")
    parser.add_argument("action", choices=("snapshot", "check"))
    location = parser.add_mutually_exclusive_group(required=True)
    location.add_argument("--project-dir")
    location.add_argument("--project")
    parser.add_argument("--workspace-root")
    parser.add_argument("--body")
    parser.add_argument("--title", default="04_title.md")
    parser.add_argument("--ledger", default="02_evidence_ledger.json")
    args = parser.parse_args()
    project = Path(args.project_dir) if args.project_dir else workspace_articles_dir(args.workspace_root) / args.project
    if args.action == "check":
        ok = publication_passed(project, args.body)
        print("PASS: 当前版本允许交付" if ok else "FAIL: 当前版本缺少有效事实核查，请重新核查")
        return 0 if ok else 1
    try:
        body = args.body or read_object(project_file(project, "run_manifest.json"))["latest_body_file"]
        print(json.dumps(snapshot_inputs(project, body, args.title, args.ledger), ensure_ascii=False, indent=2))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
