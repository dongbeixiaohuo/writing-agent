# articles 目录说明

这个目录用于存放协作写作工作流生成的所有文章产物。

## 目录结构

每篇文章都会创建一个独立的项目文件夹：

```
articles/
├── [文章标题1]/
│   ├── 00_memory_packet.md      # Stage 0: 写作记忆包（B 模式必需）
│   ├── 01_theme.md              # Stage 1: 主题与读者
│   ├── 01b_position.md          # Stage 1.5: 立场定调
│   ├── 02_scar_tissue.md        # Stage 2: 伤疤素材库
│   ├── 02_evidence_ledger.json  # Stage 2: 事实证据账本
│   ├── 03_outline.md            # Stage 3: 大纲
│   ├── 04_title.md              # Stage 5.5: 标题、平台分发文案候选与锁定结果
│   ├── 04_share_map.md          # Stage 4: 分享触点地图
│   ├── 05_concrete_library.md   # Stage 5: 具象化库
│   ├── 05c_opening_hook.md      # Stage 5.8: 锁定开头
│   ├── draft_v1.md              # Stage 6: 初稿
│   ├── draft_v1_notes.md        # Stage 6: 初稿内部备注
│   ├── draft_v2.md              # Stage 7: 修订稿
│   ├── draft_v2_notes.md        # Stage 7: 修订稿内部备注
│   ├── run_manifest.json        # 当前正文来源与流程状态
│   ├── fact_claims.json         # Stage 10.5: 锁定标题、分发文案与正文事实声明
│   ├── fact_check_report.md     # Stage 10.5: 事实核查报告
│   ├── publication_metrics.jsonl # 可选 Stage 14: 追加式发布指标账本
│   ├── performance_reviews/     # 可选 Stage 14: 发布后表现复盘
│   ├── draft_最终稿.md          # 最终版本
│   ├── changelog.md             # 变更记录
│   └── sources.md               # 引用来源
│
├── [文章标题2]/
│   └── ...
│
└── README.md                    # 本文件
```

## 文件说明

### 阶段产物

| 文件名 | 阶段 | 说明 |
|-------|------|------|
| `00_memory_packet.md` | Stage 0 | B 模式必需；历史经验或“暂无经验”占位结论 |
| `01_theme.md` | Stage 1 | 主题、观点、读者画像、目标字数 |
| `01b_position.md` | Stage 1.5 | 立场、判断边界、核心咬合点 |
| `02_scar_tissue.md` | Stage 2 | 场景、代价、细节、证据 |
| `02_evidence_ledger.json` | Stage 2 | 可外部核查事实的结构化证据账本 |
| `03_outline.md` | Stage 3 | 大纲、段落功能标注、字数预估 |
| `04_title.md` | Stage 5.5 | 8 个候选标题、3 条平台分发文案及最终锁定结果 |
| `04_share_map.md` | Stage 4 | 分享触点、共鸣点、真实讨论入口 |
| `05_concrete_library.md` | Stage 5 | 类比库、画面库、行动库 |
| `05c_opening_hook.md` | Stage 5.8 | 用户锁定的开头钩子 |

### 版本文件

| 文件名 | 说明 |
|-------|------|
| `draft_v1.md` | 初稿（Stage 6） |
| `draft_v1_notes.md` | 初稿内部备注（字数统计、素材使用、自检问题） |
| `draft_v2.md` | 修订稿（Stage 7） |
| `draft_v2_notes.md` | 修订稿内部备注（修改记录、自检、遗留问题） |
| `draft_v3.md` | 再修订（如有） |
| `run_manifest.json` | 当前正文来源、备注、clean 来源，以及事实核查绑定的正文/标题文件和 SHA-256 |
| `draft_最终稿.md` | 用户确认的最终版本 |

### 辅助文件

| 文件名 | 说明 |
|-------|------|
| `changelog.md` | 记录每次修改的变更内容 |
| `sources.md` | 引用来源（如有数据/案例） |
| `publication_metrics.jsonl` | 版本绑定、只追加的发布后表现原始记录（可选） |
| `performance_reviews/*.md` | 基于可比数据形成的观察、假设和规则候选（可选） |

## 使用示例

### 创建新项目
```
用户：我想写一篇关于"35 岁程序员危机"的文章

AI：
→ 创建项目文件夹：articles/35岁程序员危机/
→ 开始 Stage 1...
```

### 查看项目进度
```
用户：查看进度

AI：
项目：35岁程序员危机
进度：Stage 3 已完成，等待用户确认

已完成：
✅ 01_theme.md
✅ 01b_position.md
✅ 02_scar_tissue.md
✅ 03_outline.md

下一步：04_share_map.md
```

### 导出最终稿
```
用户：导出最终稿

AI：
📁 已保存：articles/35岁程序员危机/draft_最终稿.md
```

## 注意事项

1. **不要手动修改阶段产物文件**：这些文件由 Skills 自动生成，手动修改可能导致流程错乱
2. **可以手动修改草稿正文文件**：`draft_v1.md` 等文件可以手动编辑，然后告诉 AI "基于这个版本继续修改"
3. **备注请写进同名 `_notes.md`**：不要再把字数统计、修改记录写回正文文件
4. **维护 `run_manifest.json`**：新流程应把当前正文来源、备注文件和状态写进去
5. **事实核查必须双绑定**：旧的无正文或标题哈希的 `fact_check_status=passed` 不再放行，正文或 `04_title.md` 修改后都应重跑 Stage 10.5
6. **最终复制请用 `_clean.txt`**：它是发布出口，不是正文源文件；只通过 `auto_clean_hook.py --project "[项目名]"` 生成
7. **定期备份**：重要文章建议定期备份整个项目文件夹
8. **版本管理**：建议使用 Git 管理 articles 目录，方便追踪变更
9. **发布数据只追加**：只通过 `record_publish_metrics.py` 写入 `publication_metrics.jsonl`，不要覆盖旧记录或把指标混进 `run_manifest.json`

## 清理建议

- 完成的项目可以移动到 `articles/archived/` 目录
- 测试项目可以移动到 `articles/test/` 目录
- 不需要的项目可以直接删除

---

**版本：** v1.2.0

**更新时间：** 2026-08-14
