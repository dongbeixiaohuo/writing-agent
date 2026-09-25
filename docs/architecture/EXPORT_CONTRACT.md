# Writing Agent 导出合同

状态：`IMPLEMENTED_LOCAL`  
对应任务：WA-014  
权威实现：`packages/writing-core`、`packages/storage`、`packages/application`

## 1. 两类出口

`working_copy` 与 `publication` 是不同命令，不共享“可发布”含义：

| 模式 | 格式 | 门禁 | 文件语义 |
|---|---|---|---|
| `working_copy` | Markdown + `.status.json` | 不要求事实核查通过；只要求正文仍是项目当前版本 | 原样备份当前 Markdown。状态清单固定写入 `WORKING_COPY_NOT_PUBLICATION`、正文版本/hash、当时的核查状态和 operationId |
| `publication` | TXT 或 HTML | 必须通过同一 `validatePublicationGate` | 使用已锁定标题和当前正文生成正式交付文件；不是网络发布，也不上传到任何平台 |

工作备份不能写成 `_clean.txt`、不能省略状态清单，也不能因为 `not_checked/blocked/error/stale` 被扣留。正式 TXT 与 HTML 不允许各自实现一套宽松判断。

## 2. 正式导出门禁

正式导出每次都重新验证：

- 项目当前 `factGateStatus` 和计算状态均为 `passed`；请求、项目与状态指向同一当前事实快照，且没有 invalidation。
- 正文、标题和证据 Artifact 属于同一项目、类型正确、自身内容 hash 未被篡改，并分别是项目当前版本。
- 快照绑定的正文、锁定标题、分发文案和证据版本/hash 与实际内容一致，schema/policy 版本受支持。
- assessment 属于该快照、状态为 `passed`、blockers 为空、payload 绑定当前正文/标题；claims 与报告 hash 均重新计算匹配。
- 标题工件存在“已锁定”的最终标题。输出文件名只取经过清理的项目 ID/标题，不接受调用者提供的目录或目标路径。

任一条件失败都在写文件前返回稳定 `FACT_*`/`EXPORT_*` 错误。正文、标题、证据或报告在核查后变化时，旧文件可以保留作历史，但不能被新操作覆盖或冒充当前交付。

## 3. 确定性输出与安全 HTML

- TXT 以锁定标题开头，正文转为纯文本；若 Markdown 正文首个非空块也是标题，会移除该 heading，避免标题重复。
- HTML 是完整静态文档，可选择 `clean`（清爽阅读）、`editorial`（杂志长文）或 `compact`（紧凑报告）三种内置 CSS；默认 `clean` 保持旧路径兼容，另外两种在文件名中带预设名。所有标题和正文文本先转义；不输出 script、事件属性、远程资源、链接或调用者提供的 HTML。
- Windows 保留名、控制字符、路径分隔符和尾随点/空格会被清理；文件始终位于工作区 `exports/<project>/working|publication/`。
- 工作备份文件名同时绑定正文 hash 与 operationId hash，因此同一正文的多次显式备份不会因状态清单时间不同发生路径冲突。

## 4. 文件与数据库对账

schema v7 的 `exports` 是持久操作账本，不是正文或门禁的权威来源。单次操作按以下顺序完成：

1. 在 SQLite 事务中重新验证输入，保存 `prepared` 行、最终内容、相对路径、预期 SHA-256、字节数和全部门禁绑定；同一 operationId 不同输入拒绝。
2. 在目标同目录以独占临时文件写入 UTF-8，刷新文件句柄并校验 hash；仅当目标不存在时原子改名。目标已存在且 hash 不同返回 `EXPORT_TARGET_CONFLICT`，绝不覆盖。
3. 在 SQLite 事务中把记录改为 `completed`，推进 project revision，追加 `export.completed` 事件和正文到 exportId 的 `EXPORTED_AS` 来源边，并完成 operation result。

若进程在原子改名后、数据库提交前中断，重试会读取 `prepared` 行：文件 hash 等于预期时只完成数据库提交；缺失时在门禁仍有效的前提下重写；存在但 hash 不同则停止。已完成记录重放时也重新校验磁盘文件，外部篡改返回 `EXPORT_FILE_MISMATCH`。

## 5. 应用、CLI 与 UI 边界

- Application Service 是唯一业务入口；不配置模型 Provider 也可以执行导出，但启动/恢复写作 run 仍要求 Provider。
- CLI：`export working-copy` 与 `export publication --format txt|html`。CLI 读取当前项目投影，不接受任意输出路径；可传 `--operation` 做重放。
- Client Bridge v16 引入 `saveWorkingCopy`、带 `layoutPreset` 的 `exportPublication` 和 `DeliveryWorkspace`；当前 v17 保持同一导出契约并新增项目级新对话选择。Local Web 暂保 `/api/v6/*` transport prefix，并以 protocol header/handshake 17、Host/Origin/capability/generation 做实际兼容门禁。
- “备份与交付”页签把两类按钮分组，并以可访问的单选卡展示三种 HTML 排版。浏览器显示的 `formalExportEnabled` 仅是交互提示，不能替代服务端门禁；Mock 构建固定只读。

## 6. 明确不包含

WA-014 不执行网络发布、平台登录、上传、剪贴板写入、任意路径选择或 HTML 脚本执行；三种排版是安全静态文件生成，不是公众号平台自动发布。真实用户交付、安装包、远端 CI 与发布审批分别验收。
