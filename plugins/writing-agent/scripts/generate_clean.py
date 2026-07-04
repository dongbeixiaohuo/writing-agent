"""
generate_clean.py - 纯净版文本生成器 / 正文字数统计器
用途：
1. 将 Markdown 格式的文章定稿转为可直接复制到微信公众号的纯文本版本
2. 用统一口径统计正文字符数，排除元数据、分割线和写作备注

示例：
  python scripts/generate_clean.py articles/职场边界与协作智慧/draft_final.md
  python scripts/generate_clean.py --stats articles/职场边界与协作智慧/draft_v1.md
  python scripts/generate_clean.py --stdout articles/职场边界与协作智慧/draft_v1.md
"""

import argparse
import json
import re
import sys
from pathlib import Path


def iter_cleaned_lines(text: str):
    """逐行提取正文内容，统一过滤元数据和内部备注。"""
    skip_internal_block = False

    for line in text.splitlines():
        stripped = line.strip()

        if (stripped.startswith('## 写作备注') or stripped.startswith('## 修改记录')
                or (stripped.startswith('##') and '分享指南' in stripped)):
            skip_internal_block = True
            continue

        if skip_internal_block:
            if re.match(r'^#{1,2}\s+', stripped):
                skip_internal_block = False
            else:
                continue

        # 跳过图片引用 ![xxx](xxx)
        if re.match(r'!\[.*?\]\(.*?\)', stripped):
            continue

        # 跳过纯 Markdown 装饰行（分割线 ---、===、***）
        if re.match(r'^[-=*]{3,}$', stripped):
            continue

        # 跳过写作备注、元数据（> 开头的元信息行）
        if re.match(r'^>\s*(创建时间|版本|风格|字数|项目|写作备注)', stripped):
            continue

        # 跳过空行
        if not stripped:
            continue

        # 去除 Markdown 标题符号 # ## ### 等
        line_clean = re.sub(r'^#{1,6}\s+', '', stripped)

        # 去除加粗 **xxx** 和 __xxx__
        line_clean = re.sub(r'\*\*(.*?)\*\*', r'\1', line_clean)
        line_clean = re.sub(r'__(.*?)__', r'\1', line_clean)

        # 去除斜体 *xxx* 和 _xxx_（注意不要误删列表项）
        line_clean = re.sub(r'(?<!\w)\*([^*]+)\*(?!\w)', r'\1', line_clean)

        # 去除行内代码 `xxx`
        line_clean = re.sub(r'`([^`]+)`', r'\1', line_clean)

        # 去除引用符号 >
        line_clean = re.sub(r'^>\s*', '', line_clean)

        # 去除无序列表符号 - 和 *（行首）
        line_clean = re.sub(r'^[-*]\s+', '', line_clean)

        # 去除有序列表编号 1. 2. 等
        line_clean = re.sub(r'^\d+\.\s+', '', line_clean)

        # 去除链接格式 [文字](url) → 文字
        line_clean = re.sub(r'\[([^\]]+)\]\([^)]+\)', r'\1', line_clean)

        line_clean = line_clean.strip()
        if line_clean:
            yield line_clean


def clean_markdown(text: str) -> str:
    """将 Markdown 文本转为纯净排版文本。"""
    return '\n'.join(iter_cleaned_lines(text))


def build_body_stats(source_text: str, body_text: str) -> dict[str, int]:
    """生成统一口径的正文统计信息。"""
    source_lines = source_text.splitlines()
    body_lines = body_text.splitlines()
    return {
        'total_chars': len(source_text),
        'body_chars': len(body_text),
        'excluded_chars': len(source_text) - len(body_text),
        'total_lines': len(source_lines),
        'body_lines': len(body_lines),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description='生成纯净版文本，或按统一口径统计正文字符数。',
    )
    mode_group = parser.add_mutually_exclusive_group()
    mode_group.add_argument(
        '--stdout',
        action='store_true',
        help='只输出清洗后的正文，不写入 _clean.txt 文件。',
    )
    mode_group.add_argument(
        '--stats',
        action='store_true',
        help='输出正文统计信息，不写入 _clean.txt 文件。',
    )
    parser.add_argument(
        '--json',
        action='store_true',
        help='配合 --stats 使用，输出 JSON 格式。',
    )
    parser.add_argument('input_path', help='Markdown 文件路径')
    return parser.parse_args()


def main():
    args = parse_args()
    input_path = Path(args.input_path)

    if not input_path.exists():
        print(f"错误：文件不存在 → {input_path}")
        sys.exit(1)

    source_text = input_path.read_text(encoding='utf-8')
    body_text = clean_markdown(source_text)
    stats = build_body_stats(source_text, body_text)

    if args.stdout:
        print(body_text)
        return

    if args.stats:
        if args.json:
            print(json.dumps(stats, ensure_ascii=False))
            return

        print(f"正文字符数：{stats['body_chars']}")
        print(f"全文字符数：{stats['total_chars']}")
        print(f"排除字符数：{stats['excluded_chars']}")
        print(f"正文行数：{stats['body_lines']}")
        print(f"全文行数：{stats['total_lines']}")
        return

    output_name = input_path.stem + '_clean.txt'
    output_path = input_path.parent / output_name
    output_path.write_text(body_text, encoding='utf-8')
    print(f"✅ 纯净版已生成 → {output_path}")
    print(f"   正文字符数：{stats['body_chars']} 字符")


if __name__ == '__main__':
    main()
