# rc.35：项目删除误拦截与错误信息丢失

日期：2026-09-24

## 现场与根因

用户 rc.34 截图：项目名称已匹配，永久删除返回“项目删除失败，没有删除任何数据”。

以 readOnly 连接在线备份当前 SQLite 到 TEMP，仅在隔离副本执行删除。直接 storage 删除正常，完整性与外键检查正常；DesktopApplicationHost 则对所有项目返回 ACTIVE_RUNS_PRESENT。现场有多个 waiting_user，没有正在 running 的任务。

原因一：deleteProject 复用了工作区全局 hasActiveRun，将 queued/running/paused/waiting_user 一起拦截。一个项目等待确认会禁止删除任何项目。

原因二：实际 rc.34 客户端隔离复现，RPC 返回 ACTIVE_RUNS_PRESENT，而 contextBridge 传到页面的 Error 丢失了自定义 code，仅剩英文 message，界面因此使用无原因的 fallback。证据：output/delete-project/delete-pDZbNd/result.json。

## 修复边界

- 名称确认后仅检查目标项目 queued/running，返回 PROJECT_DELETE_RUN_ACTIVE；waiting_user/paused 允许作为已确认项目的一部分删除。
- 其他项目运行或等待不会阻止目标项目删除。模型配置、备份、恢复等原有全局检查不变。
- 删除接口通过 Error.message 传递安全公开错误码，避免 Electron 丢失自定义属性；页面翻译为明确中文原因与下一步。
- 补齐删除相关存储失败、只读、版本冲突、项目不存在的安全提示，不暴露底层异常、内容或路径。
- 没有改 SQLite 删除事务、级联、确认机制，没有绕过正在写入的任务保护。

## 验证

- 先新增测试得到 ACTIVE_RUNS_PRESENT 红灯，再修复。运行中测试在 host 启动恢复之后创建执行记录，避免把正确的孤儿任务恢复误当正在执行。
- desktop host、RPC、storage recovery、UI onboarding 共 24 项通过。
- npm run check:desktop 通过：类型检查、34 项测试、生产构建与 13 文件分发边界。output/rc35-desktop.log。
- 当前真实数据副本中指定一个 waiting_user 项目删除成功，7→6 项目；PRAGMA integrity_check=ok，foreign_key_check=[]。原工作区只读，不执行删除。
- 最终包原生界面：错误名称不能提交；目标正在执行时出现准确中文提示；另一项目执行时，可以删除当前选中的等待确认项目；保留其他两个项目；刷新后结果保持。output/delete-project/delete-bz3tL8/result.json、active-error.png、deleted.png。
- 初次从 OneDrive 构建目录启动遇 GPU 子进程失败，复制同一成品到 TEMP 后通过。未以此修改产品逻辑。原生 UI 检查不是安装升级验证。
- 本轮没有模型调用、自动安装、原项目修改或对外发布，不上调整体用户验收状态。

## 交付

output/desktop/Writing-Agent-Setup-1.0.0-rc.35-x64.exe

包内版本：1.0.0-rc.35。NSIS 构建日志：output/rc35-package.log。

SHA256：92E12065C52CAB0673342BA94ECB9C06008961CB037AFD409B7A4CBB6BFEEA39
