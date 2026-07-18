"""
style_fingerprint.py - 风格量化指纹统计器

对样本文章做客观的节奏统计，替代肉眼估算，为风格建模提供实测基线：
句长分布、问句/叹句占比、短段占比、标点密度、高频句首词。

用法：
python "${CLAUDE_SKILL_DIR}/scripts/style_fingerprint.py" docs/样本1.md docs/样本2.md
python "${CLAUDE_SKILL_DIR}/scripts/style_fingerprint.py" --json docs/样本1.md
"""

import argparse
import json
import re
import sys
from collections import Counter
from pathlib import Path
from statistics import median

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ('utf-8', 'utf8'):
    sys.stdout.reconfigure(encoding='utf-8')
    sys.stderr.reconfigure(encoding='utf-8')

SENT_END = r'[。！？!?；;…]+'
META_LINE = re.compile(r'^\s*(>|#|\||!\[|---|===|\*\*\*)')


def extract_body_lines(text: str):
    """去掉非正文行，并按 Markdown 空行边界合并折行后的正文段落。"""
    paragraphs = []
    current = []

    def flush_current():
        if current:
            paragraphs.append(''.join(current))
            current.clear()

    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            flush_current()
            continue
        if META_LINE.match(stripped):
            flush_current()
            continue
        # 去除加粗/斜体标记
        stripped = re.sub(r'\*\*(.*?)\*\*', r'\1', stripped)
        stripped = re.sub(r'\*(.*?)\*', r'\1', stripped)
        current.append(stripped)

    flush_current()
    return paragraphs


def split_sentences(lines):
    sentences = []
    for line in lines:
        parts = re.split(f'({SENT_END})', line)
        buf = ''
        for part in parts:
            if re.fullmatch(SENT_END, part):
                if buf.strip():
                    sentences.append((buf.strip(), part))
                buf = ''
            else:
                buf += part
        if buf.strip():
            sentences.append((buf.strip(), ''))
    return sentences


def sentence_head(sent: str, max_len: int = 4):
    """取句首词：前 2-4 个字符中最像"起手词"的切片（简化：取前2字和前3字）。"""
    s = re.sub(r'^["“」『（(【\s]+', '', sent)
    return s[:2], s[:3]


def analyze(paths):
    all_sentences = []
    all_paragraphs = []
    file_count = 0

    for p in paths:
        path = Path(p)
        if not path.exists():
            print(f"警告: 找不到 {p}，已跳过", file=sys.stderr)
            continue
        file_count += 1
        text = path.read_text(encoding='utf-8', errors='ignore')
        lines = extract_body_lines(text)
        all_paragraphs.extend(lines)
        all_sentences.extend(split_sentences(lines))

    if not all_sentences:
        print("错误: 没有可分析的正文", file=sys.stderr)
        sys.exit(1)

    lengths = sorted(len(s) for s, _ in all_sentences)
    n = len(lengths)
    avg_len = sum(lengths) / n
    median_len = median(lengths)

    def pct_in(lo, hi):
        return sum(1 for L in lengths if lo <= L <= hi) / n * 100

    q_count = sum(1 for s, end in all_sentences if '？' in end or '?' in end)
    e_count = sum(1 for s, end in all_sentences if '！' in end or '!' in end)

    para_lens = [len(p) for p in all_paragraphs]
    short_para = sum(1 for L in para_lens if L <= 40) / len(para_lens) * 100 if para_lens else 0

    full_text = ''.join(p for p in all_paragraphs)
    total_chars = len(full_text) or 1
    ellipsis_count = len(re.findall(r'…+|\.{3,}|。{3,}', full_text))
    dash_count = len(re.findall(r'—+|-{2,}', full_text))
    ellipsis_per_k = ellipsis_count / total_chars * 1000
    dash_per_k = dash_count / total_chars * 1000

    heads2 = Counter()
    heads3 = Counter()
    for s, _ in all_sentences:
        h2, h3 = sentence_head(s)
        if len(h2) == 2:
            heads2[h2] += 1
        if len(h3) == 3:
            heads3[h3] += 1
    # 3字头出现>=3次的优先，其余用2字头补足
    top_heads = [(w, c) for w, c in heads3.most_common(10) if c >= 3]
    seen_prefix = {w[:2] for w, _ in top_heads}
    for w, c in heads2.most_common(15):
        if c >= 3 and w not in seen_prefix and len(top_heads) < 10:
            top_heads.append((w, c))

    return {
        'files': file_count,
        'sentences': n,
        'paragraphs': len(all_paragraphs),
        'avg_sentence_len': round(avg_len, 1),
        'median_sentence_len': median_len,
        'len_dist': {
            '短句(<=15字)%': round(pct_in(0, 15), 1),
            '中句(16-30字)%': round(pct_in(16, 30), 1),
            '长句(31-50字)%': round(pct_in(31, 50), 1),
            '超长句(>50字)%': round(pct_in(51, 10 ** 6), 1),
        },
        'question_pct': round(q_count / n * 100, 1),
        'exclaim_pct': round(e_count / n * 100, 1),
        'short_para_pct': round(short_para, 1),
        'ellipsis_per_1k_chars': round(ellipsis_per_k, 2),
        'dash_per_1k_chars': round(dash_per_k, 2),
        'top_sentence_heads': [f"{w}({c})" for w, c in top_heads[:8]],
    }


def main():
    parser = argparse.ArgumentParser(description='风格量化指纹统计')
    parser.add_argument('files', nargs='+', help='样本文件路径（可多个）')
    parser.add_argument('--json', action='store_true', help='输出 JSON 格式')
    args = parser.parse_args()

    result = analyze(args.files)

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    print('═' * 45)
    print(f"📐 量化指纹（样本 {result['files']} 篇，{result['sentences']} 句 / {result['paragraphs']} 段）")
    print('═' * 45)
    print(f"平均句长：{result['avg_sentence_len']} 字   中位句长：{result['median_sentence_len']} 字")
    for k, v in result['len_dist'].items():
        print(f"  {k}: {v}%")
    print(f"问句占比：{result['question_pct']}%   叹句占比：{result['exclaim_pct']}%")
    print(f"短段(≤40字)占比：{result['short_para_pct']}%")
    print(f"省略号密度：{result['ellipsis_per_1k_chars']}/千字   破折号密度：{result['dash_per_1k_chars']}/千字")
    print(f"高频句首词：{'、'.join(result['top_sentence_heads']) or '（无 ≥3 次的句首词）'}")


if __name__ == '__main__':
    main()
