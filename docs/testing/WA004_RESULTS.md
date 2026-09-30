# WA-004 架构与基础 CI 验证结果

状态：`PASS_LOCAL`  
日期：2026-09-16  
分支：`next/runtime`

## 1. 完成范围

- 新增 ADR-0001 至 ADR-0005，覆盖自主运行时、SQLite/恢复、同源分发/transport、legacy 迁移/导出语义和 DSH 前端源码复用。
- 新增 `m0-foundation` GitHub Actions job，在 Windows/Linux 的 Node 24.18.0 上运行 M0 检查；保留原 `check` job、Node 20 和 job 名称。
- 新增 `npm run check:m0`、架构约束测试与 `node:sqlite` 冒烟测试。
- 根包仍为 `private: true`，legacy engine 仍为 Node `>=18.17.0`；CI 未引用尚未实现的 runtime/UI 命令。
- 未修改需求包状态、未复制 DSH 代码、未操作真实项目数据、未执行远端写入。

## 2. 验证环境

| 项目 | 值 |
|---|---|
| OS | Windows（本地工作区） |
| Python | 3.11.8 |
| Node | 24.18.0 |
| npm | 11.16.0 |
| Git 分支 | `next/runtime` |

## 3. 命令与结果

### `npm run check:m0`

结果：PASS。

- `node:sqlite` 在磁盘临时库上验证 WAL、foreign key、STRICT 表、`BEGIN IMMEDIATE` 事务、`quick_check` 和 online backup/readback。
- 架构、来源 registry 和 legacy fixture 共 11 项测试通过。
- 临时目录由脚本创建，并在校验其位于系统临时目录后删除。

### `npm run check`

结果：PASS。

- Python：226 项通过，1 项按设计跳过。跳过项是隔离插件安装测试，需 `RUN_PLUGIN_INSTALL_TEST=1`；GitHub Actions 的原 legacy job 会另行带该变量运行。
- Python syntax：26 个文件通过。
- workflow/doc validation：通过。
- `claude-runtime` 镜像同步：通过。
- plugin 与 marketplace strict validation：通过。

随后按 CI 环境设置 `RUN_PLUGIN_INSTALL_TEST=1` 单独执行隔离插件安装测试，1 项通过，确认跳过项不是未验证失败。

首次运行时，SQLite 冒烟脚本放在严格镜像的根 `scripts/`，同步检查正确报告一个 extra file。随后将该测试脚本移至 `tests/`；未放宽同步规则，复跑整链通过。

### `git diff --check`

结果：PASS。仅显示工作树在 Windows 下后续可能进行 LF→CRLF 转换的提示，没有 whitespace error。

### CI YAML 语法

使用本机 PyYAML 读取 `.github/workflows/packaging.yml`，结果 PASS；这只证明 YAML 可解析，不替代尚未发生的 GitHub Actions 远端运行。

### `npm audit --omit=dev --audit-level=high`

初次执行发现锁文件中的 `js-yaml` high、`fflate` moderate 和 `esbuild` low 公告，会使现有 CI 的 high 门槛失败。按已有 semver 范围做最小升级：

- `fflate` 0.8.2 → 0.8.3；
- `tsx` 4.21.0 → 4.23.13，并将其 `esbuild` 0.27.3 → 0.28.2；
- `front-matter` 的 transitive `js-yaml` 3.15.1 → 3.15.2。

没有新增依赖。更新后 production audit 为 0 vulnerabilities；随后执行干净 `npm ci --ignore-scripts`，安装 306 个包且 audit 仍为 0，`tsx v4.23.13` 可运行。

根依赖更新后，严格同步检查正确报告插件发行镜像的两份 package 文件漂移。使用仓库既有 `sync_claude_runtime.py` 生成 `plugins/writing-agent/package.json` 与 lock；没有放宽同步规则，最终回归同时核对根包和插件镜像。

### 需求包检查

结果：PASS。

- 25 个任务可解析，依赖图无环且引用完整。
- UI 并行线路与汇合关系通过。
- 38 个验收场景及需求/来源/链接引用通过。

## 4. 尚未执行

- 没有 push，因此本次新增 GitHub Actions job 尚无远端 run；这里只记录等价本地命令通过。
- 没有创建 commit、PR、Issue、tag 或 Release。
- 没有执行 WA-005 的真实 schema/事务实现，也没有执行 WA-023 的源码复制、页面启动和视觉对照。
- 没有进行 Electron 安装包构建；该项属于后续 WA-017，不能由 `node:sqlite` 冒烟替代。

## 5. WA-004 完成判据核对

- [x] 固定普通库和模块边界，不依赖外部 DSH/Claude 宿主。
- [x] 固定 SQLite、备份/恢复、transport、分发和旧导出兼容策略。
- [x] 保留 `main`，使用 `next/runtime` 和小 PR 路线。
- [x] 核对根包 `private` 状态，不宣传未实现 npm 命令。
- [x] 固定 DSH UI 直接源码移植与 Electron 最小壳路线，禁止旧 Tauri 回流。
- [x] 明确 WA-005 与 WA-023 并行，以及 theme/Slot/protocol 汇合边界。
- [x] 基础 CI 配置及本地等价检查通过，未掩盖远端 CI 尚未运行。
