"""Prepare and summarize local, human-scored paired blind reviews.

No network client, LLM call, or article generation is used here.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import random
import re
from collections import Counter
from pathlib import Path

DIMENSIONS = ("information_gain", "structure", "specific_detail", "author_voice", "reading_appeal", "factual_credibility")
SCORE_FIELDS = ("case_id", "preferred", "major_fact_error_a", "major_fact_error_b") + tuple(f"{side}_{dimension}" for side in ("a", "b") for dimension in DIMENSIONS)


class ReviewError(ValueError):
    """An input cannot safely produce or summarize a blind review."""


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def resolve_body(value: Path) -> Path:
    """Resolve an article file or project manifest, without path escape."""
    value = value.resolve()
    if value.is_file():
        return value
    manifest = value / "run_manifest.json"
    if not manifest.is_file():
        raise ReviewError(f"缺少可用正文：{value} 不是文件且没有 run_manifest.json")
    try:
        payload = json.loads(manifest.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ReviewError(f"run_manifest.json 无法解析：{manifest}") from exc
    if not isinstance(payload, dict):
        raise ReviewError(f"run_manifest.json 顶层必须是对象：{manifest}")
    body_name = payload.get("latest_body_file")
    if not isinstance(body_name, str) or not body_name.strip() or Path(body_name).is_absolute():
        raise ReviewError(f"manifest 缺少合法 latest_body_file：{manifest}")
    body = (value / body_name).resolve()
    if not _inside(body, value) or not body.is_file():
        raise ReviewError(f"manifest 指向的正文不存在或越出项目：{body_name}")
    return body


def blind_text(text: str) -> str:
    """Remove only known version/source metadata; keep title, body and citations."""
    lines = text.lstrip("\ufeff").splitlines()
    if lines and lines[0].strip() == "---":
        end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
        if end is not None:
            kept = [line for line in lines[1:end] if not re.match(r"\s*(version|style|author|path|source|model|prompt[_ -]?version)\s*:", line, re.I)]
            lines = (["---", *kept, "---"] if kept else []) + lines[end + 1:]
    marker = re.compile(r"^>\s*(版本|风格|作者|创建时间|项目|来源路径|输入路径|模型|提示词版本|version|style|author|source path|input path|model|prompt version)\s*[:：]", re.I)
    result = []
    in_header = True
    in_frontmatter = bool(lines and lines[0] == "---")
    for index, line in enumerate(lines):
        if in_frontmatter:
            result.append(line)
            if index > 0 and line == "---":
                in_frontmatter = False
            continue
        if in_header and marker.match(line):
            continue
        if line.strip() and not line.startswith("# ") and line.strip() != "---":
            in_header = False
        result.append(line)
    return "\n".join(result).strip() + "\n"


def _preflight(output_dir: Path, key_path: Path) -> tuple[Path, Path]:
    output_dir, key_path = output_dir.resolve(), key_path.resolve()
    if key_path == output_dir or _inside(key_path, output_dir):
        raise ReviewError("保密对照表必须写在盲评包目录之外")
    if key_path.exists():
        raise ReviewError(f"拒绝覆盖已有保密对照表：{key_path}")
    if output_dir.exists() and any(output_dir.iterdir()):
        raise ReviewError(f"盲评输出目录必须为空：{output_dir}")
    return output_dir, key_path


def _write_template(path: Path, case_ids: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=SCORE_FIELDS)
        writer.writeheader()
        writer.writerows({"case_id": case_id} for case_id in case_ids)


def _rubric() -> str:
    return ("# 配对盲评\n\n阅读每组 A/B 后填写 scores.csv。不要猜测来源或版本。\n\n"
            "六个维度均为 1–5 分：信息增量、结构、具体细节、作者声音、阅读吸引力、事实可信度。"
            "`preferred` 填 A、B 或 TIE；重大事实错误填 yes/no。事实重大错误是独立否决项，不能由其他高分抵消。\n")


def _mapping(seed: int, case_id: str) -> dict[str, str]:
    labels = ["baseline", "candidate"]
    random.Random(f"{seed}:{case_id}").shuffle(labels)
    return {"A": labels[0], "B": labels[1]}


def _write_packet(entries: dict[str, dict[str, str]], output_dir: Path, key_path: Path, seed: int,
                  model: str | None = None, prompt_version: str | None = None,
                  case_context: dict | None = None) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    packet_cases, key_cases = [], {}
    for case_id, texts in entries.items():
        mapping = _mapping(seed, case_id)
        files = []
        for side in ("A", "B"):
            filename = f"{case_id}-{side}.md"
            (output_dir / filename).write_text(blind_text(texts[mapping[side]]), encoding="utf-8")
            files.append(filename)
        packet_cases.append({"case_id": case_id, "files": files})
        key_cases[case_id] = {**mapping, "input_sha256": {label: _sha256(text) for label, text in texts.items()}}
    (output_dir / "rubric.md").write_text(_rubric(), encoding="utf-8")
    _write_template(output_dir / "scores.csv", list(entries))
    (output_dir / "packet.json").write_text(json.dumps({"format": "writing-blind-review-v2", "cases": packet_cases}, ensure_ascii=False, indent=2), encoding="utf-8")
    if case_context is not None:
        (output_dir / "briefs.json").write_text(json.dumps(case_context, ensure_ascii=False, indent=2), encoding="utf-8")
    key_path.parent.mkdir(parents=True, exist_ok=True)
    key_path.write_text(json.dumps({"format": "writing-blind-review-key-v2", "seed": seed, "model": model, "prompt_version": prompt_version, "cases": key_cases}, ensure_ascii=False, indent=2), encoding="utf-8")


def prepare_pair(baseline: Path, candidate: Path, output_dir: Path, key_path: Path, seed: int | None = None) -> None:
    baseline_body, candidate_body = resolve_body(baseline), resolve_body(candidate)
    texts = {"baseline": baseline_body.read_text(encoding="utf-8"), "candidate": candidate_body.read_text(encoding="utf-8")}
    if not all(text.strip() for text in texts.values()):
        raise ReviewError("正文不能为空，不能生成假盲评结果")
    output_dir, key_path = _preflight(output_dir, key_path)
    actual_seed = random.SystemRandom().randrange(0, 2**63) if seed is None else seed
    _write_packet({"pair-001": texts}, output_dir, key_path, actual_seed)


def _suite_body(root: Path, case_id: str) -> Path:
    direct, project = root / f"{case_id}.md", root / case_id
    if direct.is_file():
        return resolve_body(direct)
    if project.exists():
        return resolve_body(project)
    raise ReviewError(f"缺少案例 {case_id} 的正文：期望 {direct.name} 或项目目录")


def prepare_suite(baseline_dir: Path, candidate_dir: Path, cases_path: Path, output_dir: Path, key_path: Path,
                  seed: int | None = None, model: str | None = None, prompt_version: str | None = None) -> None:
    try:
        case_context = json.loads(cases_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewError(f"案例文件不可读取：{cases_path}") from exc
    cases = case_context.get("cases") if isinstance(case_context, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ReviewError("案例文件缺少 cases")
    case_ids = [case.get("id") for case in cases if isinstance(case, dict)]
    if (len(case_ids) != len(cases)
            or any(not isinstance(item, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", item) for item in case_ids)
            or len(set(case_ids)) != len(case_ids)):
        raise ReviewError("案例 id 必须唯一且仅含字母、数字、下划线或连字符")
    actual_seed = random.SystemRandom().randrange(0, 2**63) if seed is None else seed
    entries: dict[str, dict[str, str]] = {}
    for case_id in case_ids:  # Resolve all first: missing input writes neither packet nor key.
        baseline, candidate = _suite_body(baseline_dir.resolve(), case_id), _suite_body(candidate_dir.resolve(), case_id)
        texts = {"baseline": baseline.read_text(encoding="utf-8"), "candidate": candidate.read_text(encoding="utf-8")}
        if not all(text.strip() for text in texts.values()):
            raise ReviewError(f"案例 {case_id} 的正文不能为空")
        entries[case_id] = texts
    output_dir, key_path = _preflight(output_dir, key_path)
    _write_packet(entries, output_dir, key_path, actual_seed, model, prompt_version, case_context)


def _parse_bool(value: str | None, field: str) -> bool:
    normalized = (value or "").strip().lower()
    if normalized in {"yes", "true", "1"}: return True
    if normalized in {"no", "false", "0"}: return False
    raise ReviewError(f"{field} 只能填 yes 或 no")


def _validated_cases(key_path: Path) -> dict:
    try:
        key = json.loads(key_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReviewError("保密对照表无法解析") from exc
    cases = key.get("cases") if isinstance(key, dict) else None
    if not isinstance(cases, dict) or not cases: raise ReviewError("保密对照表缺少 cases")
    for case_id, mapping in cases.items():
        if (not isinstance(case_id, str) or not isinstance(mapping, dict)
                or not isinstance(mapping.get("A"), str) or not isinstance(mapping.get("B"), str)
                or {mapping["A"], mapping["B"]} != {"baseline", "candidate"}):
            raise ReviewError(f"{case_id} 的 key 映射必须恰为 baseline/candidate")
    return cases


def summarize(scores_path: Path, key_path: Path, output_path: Path) -> dict:
    scores_path, key_path, output_path = scores_path.resolve(), key_path.resolve(), output_path.resolve()
    if output_path in {scores_path, key_path}: raise ReviewError("汇总结果不得覆盖 scores 或 key 输入")
    cases = _validated_cases(key_path)
    with scores_path.open(encoding="utf-8", newline="") as handle: rows = list(csv.DictReader(handle))
    seen, totals, preferences, vetoes = set(), {label: {d: [] for d in DIMENSIONS} for label in ("baseline", "candidate")}, Counter(), Counter()
    for row in rows:
        case_id = (row.get("case_id") or "").strip()
        if case_id not in cases: raise ReviewError(f"未知 case_id：{case_id}")
        if case_id in seen: raise ReviewError(f"重复 case_id：{case_id}")
        seen.add(case_id); mapping = cases[case_id]
        preferred = (row.get("preferred") or "").strip().upper()
        if preferred not in {"A", "B", "TIE"}: raise ReviewError(f"{case_id} 的 preferred 只能填 A、B 或 TIE")
        preferences[mapping[preferred] if preferred != "TIE" else "tie"] += 1
        for side in ("a", "b"):
            label = mapping[side.upper()]
            if _parse_bool(row.get(f"major_fact_error_{side}", ""), f"{case_id}.major_fact_error_{side}"): vetoes[label] += 1
            for dimension in DIMENSIONS:
                try: score = int((row.get(f"{side}_{dimension}") or "").strip())
                except ValueError as exc: raise ReviewError(f"{case_id}.{side}_{dimension} 必须是 1–5 整数") from exc
                if score not in range(1, 6): raise ReviewError(f"{case_id}.{side}_{dimension} 必须是 1–5 整数")
                totals[label][dimension].append(score)
    missing = sorted(set(cases) - seen)
    if missing: raise ReviewError(f"缺少评分：{', '.join(missing)}；缺失评分不会按 0 处理")
    means = {label: {d: round(sum(v) / len(v), 2) for d, v in dimensions.items()} for label, dimensions in totals.items()}
    result = {"reviewed_pairs": len(rows), "means": means, "candidate_minus_baseline": {d: round(means["candidate"][d] - means["baseline"][d], 2) for d in DIMENSIONS}, "preference_counts": dict(preferences), "major_fact_error_vetoes": dict(vetoes), "interpretation": "仅为人工盲评描述统计；不宣称显著性、因果或真实发布效果。"}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="本地配对盲评材料准备与汇总")
    sub = parser.add_subparsers(dest="command", required=True)
    prepare = sub.add_parser("prepare")
    prepare.add_argument("--baseline", type=Path, required=True); prepare.add_argument("--candidate", type=Path, required=True); prepare.add_argument("--out", type=Path, required=True); prepare.add_argument("--key-out", type=Path, required=True); prepare.add_argument("--seed", type=int)
    suite = sub.add_parser("prepare-suite")
    suite.add_argument("--baseline-dir", type=Path, required=True); suite.add_argument("--candidate-dir", type=Path, required=True); suite.add_argument("--cases", type=Path, required=True); suite.add_argument("--out", type=Path, required=True); suite.add_argument("--key-out", type=Path, required=True); suite.add_argument("--seed", type=int); suite.add_argument("--model"); suite.add_argument("--prompt-version")
    report = sub.add_parser("summarize")
    report.add_argument("--scores", type=Path, required=True); report.add_argument("--key", type=Path, required=True); report.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "prepare": prepare_pair(args.baseline, args.candidate, args.out, args.key_out, args.seed)
        elif args.command == "prepare-suite": prepare_suite(args.baseline_dir, args.candidate_dir, args.cases, args.out, args.key_out, args.seed, args.model, args.prompt_version)
        else: summarize(args.scores, args.key, args.out)
    except ReviewError as exc: parser.error(str(exc))


if __name__ == "__main__": main()
