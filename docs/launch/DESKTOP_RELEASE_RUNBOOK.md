# 桌面版发布操作手册（维护者）

本文件是操作说明。2026-09-30 维护者已授权完成公开 RC 收尾与发布，并接受未签名 RC；按 [Release Gate](../testing/RELEASE_GATE.md)验证最终候选后发布 Pre-release，不按稳定版宣传，不改变全仓库 latest。

## 1. 源码范围：先审查，后精确提交

1. 核对 `git status --short`、`git diff --stat` 和每个新增文件。产品修复、所需源码/测试、发布文档可进入审查；用户文章、Key、数据库、业务报告、临时脚本及安装包不入源码。
2. 对这次 rc.54–57，特别核对 `conversation-intent.ts`、`fact-search.ts`、桌面与 UI 的 `search-settings.ts` 和相关测试是否都纳入，不能只提交引用它们的文件。
3. 精确 `git add -- <逐个已审查路径>`，再看 `git diff --cached --stat` 和 `git diff --cached --check`。不要 `git add .`。
4. 提交前审查新增历史教程与测试脚本是否包含个人路径、私人内容、内网地址或凭据。自动模式扫描只是辅助，不能代替人工审查；已有 Git 历史也需考虑。
5. 提交到已确认的工作分支，通过 PR 合并到 main；不要绕过分支保护、强推或移动旧 Tag。

## 2. 文档与版本

- 桌面版本来自 `apps/desktop/package.json`，按桌面版本生成安装包；对应包身份测试同步更新。
- 根 `package.json` / Skill 版本不跟着桌面 RC 任意改动。
- 桌面 Tag 使用 `desktop-v` 加桌面版本，例如 **命名示例** `desktop-v1.0.0-rc.58`，不是已存在的下载地址。
- README 第一屏区分桌面与 Skill。发布前只链接 Releases 列表并标注未发布，不制造 404 安装包链接。
- 保留历史 Skill 和旧 Tauri Release；新桌面不使用含混的仓库 `latest` 链接，除非已明确全仓库 latest 策略。

## 3. 自动与人工验收

现有 `.github/workflows/desktop-rc.yml` 是手动触发的候选构建流程，上传 Actions artifact，只保留 7 天，**不是面向普通用户的下载入口**。当前不自动创建 Release。

合并后的最终 SHA 需运行候选工作流，并检查 Runtime、UI、Bridge、Desktop、搜索专项、Python、工作流/镜像、依赖审计和安装测试。`check:runtime` 已要求搜索专项，`test:ui` 包含确认摘要渲染回归。

还需 [Release Gate](../testing/RELEASE_GATE.md) 的真实模型、搜索、干净机、原位升级和人工交互验收。不得把“CI 绿”当作全部业务验收通过。

**不要在日常安装环境执行 `test_desktop_installer.ps1` 或升级测试。** 这些脚本会安装/卸载，应在干净 Windows VM/Runner 使用；拒绝检测到真实安装是保护，不要移除保护来强行测试。

GPU 故障路径对照需分别记录 executable 与 userData 的位置。只把用户数据放到 TEMP，不代表程序从 TEMP 启动。同一份 app.asar 和 exe 校验一致后，再对照 OneDrive 路径与本地短路径，避免误判为模型故障。

## 4. 锁定最终 commit 后构建

优先使用干净 CI checkout。记录 commit SHA、版本、运行链接和测试结果，不从带未审查改动的日常工作区直接公开产物。

```powershell
git rev-parse HEAD
git status --porcelain
npm ci
npm run desktop:package
```

`git status --porcelain` 应为空；后续生成物处于忽略范围。构建与测试版本必须一致。如果最终 SHA/版本改变，重新构建并重新核对受影响测试。

## 5. 只整理本版本资产与校验值

用户指定本地交付目录为仓库的 `output/desktop` **根目录**。每次生成或从 CI 下载的最新安装包，都必须在该目录直接提供 `Writing-Agent-Setup-<version>-x64.exe`；不能仅放在 `rc*-build`、`release-*` 等子目录后让用户另找。隔离构建与历史验证证据可以保留在子目录，但交付前须将最终安装包复制到根目录并核对 SHA-256。若根目录已有同名文件，先核对来源与哈希，保留旧测试包证据后再更新，不混用测试包与公开构建的校验值。

校验脚本只收录当前桌面版本，不把历代安装包汇总上传到本次 Release。

以下 PowerShell 示例仅整理当前桌面版本，使用全新子目录，不删除旧安装包：

```powershell
$releaseVersion = (Get-Content -Raw apps/desktop/package.json | ConvertFrom-Json).version
$releaseFile = "Writing-Agent-Setup-$releaseVersion-x64.exe"
$releaseDirectory = Join-Path 'output/desktop' "release-$releaseVersion"
if (Test-Path -LiteralPath $releaseDirectory) { throw '发布目录已存在，请先人工核对，不覆盖旧资产' }
New-Item -ItemType Directory -Path $releaseDirectory | Out-Null
Copy-Item -LiteralPath (Join-Path 'output/desktop' $releaseFile) -Destination $releaseDirectory
# 当前没有自动更新：blockmap 不作为普通用户必需下载项。
$releaseAsset = Join-Path $releaseDirectory $releaseFile
$releaseHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseAsset).Hash.ToLowerInvariant()
"$releaseHash  $releaseFile" | Set-Content -LiteralPath (Join-Path $releaseDirectory 'SHA256SUMS.txt') -Encoding utf8
Get-AuthenticodeSignature -LiteralPath $releaseAsset | Select-Object Status
```

这里是在发布操作手册中给出资产生成命令，不代表已经执行。签名必须在最终计算哈希前完成；若资产字节变化则重新校验。

检查候选包不含 Key、用户库、私人稿件、绝对开发路径、源码映射和无关运行时。保留 LICENSE、THIRD_PARTY_NOTICES 和构建清单。安装包未签名时，维护者需明确接受公开风险，并在 Release 说明，不要求用户关闭安全防护。

## 6. 创建 Release 草稿并签收

得到明确的远端操作授权后：

1. 从最终验收 commit 创建不可随意移动的桌面 Tag。
2. GitHub → Releases → Draft a new release，选择对应 Tag，标题标注“Writing Agent 桌面版 + 版本 + Windows x64”。
3. 根据 [Release 草稿](DESKTOP_RELEASE_DRAFT.md)填写内容；发布正文中的文档链接改为锁定 Tag 下的 GitHub 完整链接，不把仓库相对路径原样粘到 Release。公开测试版勾选 Pre-release，不设置为仓库 latest。
4. 上传 **本版本** `.exe` 与 `SHA256SUMS.txt`，核对文件名、大小、签名、哈希；不要上传整个 output 或用户测试数据库。
5. 草稿状态下完成维护者签收。批准后 Publish release，再以未登录视角核对资产可访问，重新下载验证哈希。
6. 将 README 桌面入口改为该 Release 的真实固定链接，或提供真实资产直链；链接只有在公开后才可供普通用户访问。

固定链接格式为 `https://github.com/dongbeixiaohuo/writing-agent/releases/tag/<实际桌面Tag>`，资产直链为 `/releases/download/<实际桌面Tag>/<实际文件名>`。尖括号内容必须替换为已存在的发布值，不把模板贴到首页充当下载按钮。

## 7. 发布后与回退

- 当前客户端没有自动更新；向用户说明重新下载安装与备份步骤。
- Issue 模板/反馈要求版本、系统、协议、步骤、脱敏运行记录，不收集 Key 或完整私人数据库。
- 出现严重问题，先标明问题版本和受影响范围，按需要下架问题附件；保留历史说明，修复用新版本，不替换成同名不同哈希资产而不告知。
- 不强推 main、不移动已发布 Tag。程序降级前核对数据库兼容，必要时恢复旧版备份，不能承诺任何新库都能被旧程序打开。

规则依据：[GitHub Releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)、[Release 链接](https://docs.github.com/en/repositories/releasing-projects-on-github/linking-to-releases)。
