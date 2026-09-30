# rc.10：澄清方案返回格式校验失败

日期：2026-09-20。整体业务仍为 `BLOCKED_CORE_WORKFLOW`，本次不能等同于最终用户验收。

## 当前现场

用户在 rc.9 原会话发送“继续”，第 4 次运行失败。只读核验当前正式工作区事件，未修改原项目或读取凭据。

- Run：`9a5d6fa7-b780-4063-b600-176d9337de6d`，本地 16:12:41–16:13:37，3 次模型请求、0 次工具执行；终态 `MODEL_RESPONSE_INVALID`。未触发调用上限。
- 三次 `request.failed` 均明确是 `respond_writing_intake` 参数未通过 JSON Schema，而非网络、鉴权或账户额度失败。
- 首次失败涉及 `/proposal/brief/schemaVersion`、`lengthTarget/targetCharacters`、`authorAuthorization/styleReference`、`authorAuthorization/firsthandMaterialIds`。后两次仍有空风格值和亲历材料列表类型失败。
- 持久记录包含校验路径、规则和期望值，未保留这三次失败的完整工具原始参数；因此未声称拿到了完整原始响应或逐字重放。回归使用不含用户材料的合成业务方案。

## 根因与职责调整

rc.9 修复的是“成功提交后多余模型收尾”，没有解决模型生成方案时的数据契约负担。旧工具要求模型生成完整内部 `WritingBrief`，包括固定版本、系统材料 ID、授权枚举及确认状态；这些字段已有确定性工程来源，却让模型重复生成并承受格式失败。

- `respond_writing_intake` 工具契约升级为 2.0.0；`proposal.brief` 只接收主题、体裁、读者、目标篇幅、约束、发布目标与可选的语气/风格/平台偏好。
- 应用构造 schemaVersion=1、co_creation、tentative、unspecified 等内部状态，按真实已存材料生成引用及亲历材料列表。模型无权提交或覆盖这些字段；额外权限字段仍拒绝，不是静默接受。
- 仅对无歧义表示进行归一化：纯正整数字符串转数字；可选偏好空字符串转 null。模糊范围、非整数、超范围、非法权限仍失败；来源原文、建议披露、用户确认、版本冲突与取消约束仍有效。
- 传入模型的历史方案也投影为业务字段，避免从历史完整存储对象抄回内部元数据。既有持久简报与会话格式不变，不需要迁移用户数据。
- 主对话与运行记录对 `MODEL_RESPONSE_INVALID` 均说明“回复未通过格式校验，输入保留”，不再裸露代码或无依据要求用户换模型。

## 验证

- 红绿回归：精简业务方案在旧实现下无法提交；新实现成功生成完整暂定简报，一次请求完成。UI 原始错误码用例也先失败后通过。
- 新增负向回归：模糊篇幅、超范围字符串、模型设置 autonomous、伪造亲历授权均拒绝，未生成简报或正文。
- 既有材料绑定、自然确认、否定/修改使旧方案失效、同批多响应抑制、取消、跨轮恢复与 rc.9 边界回归通过。
- `npm run check:runtime` 通过，含 27 项 conversation 测试；UI、Desktop 回归以及 Runtime/Web/Desktop 类型检查通过。

## 交付与边界

- 安装包：`output/desktop/Writing-Agent-Setup-1.0.0-rc.10-x64.exe`，111,361,526 字节，未签名；blockmap 与 SHA256SUMS 同目录，旧安装包保留。
- SHA256：`53375e049c731bc21130b7ffec976f3d1366626d19a4ae94ea5f7fdad62113da`。
- 16:44 打包运行时隔离启动通过，Bridge v19、本地页面加载、退出码 0、stderr 为空；见 `output/desktop/rc10-proposal-smoke.json`。Bridge 40 项回归亦通过。
- 未关闭当前用户客户端，未修改原项目，未安装升级。已向用户请求独立项目的真实 MiniMax-M3 验证授权，尚未收到答复；当前结论只覆盖代码、确定性回归和交付检查，不能声称真实自由对话已通过。
