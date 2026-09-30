# WA-010 CLI 示例

## 确定性 mock（已自动验证）

在仓库根目录使用一个新的临时 workspace：

```powershell
$demoWorkspace = Join-Path $env:TEMP ("writing-agent-wa010-" + [guid]::NewGuid())
npm run runtime:cli -- run `
  --workspace $demoWorkspace `
  --project walk-demo `
  --name "散步示例" `
  --mode quick `
  --brief (Resolve-Path "examples/writing-pack/mock/brief.json") `
  --material (Resolve-Path "examples/writing-pack/mock/material.md") `
  --material-id walk-notes `
  --material-role user_firsthand `
  --provider-config (Resolve-Path "examples/writing-pack/mock/provider.json")
```

成功输出必须包含：`status=draft_saved`、`validationKind=mock_verified`、`publicationReady=false` 和 `factGateStatus=not_checked`。该命令验证的是材料工具往返、预算、事件和稿件落库，不是模型质量或正式交付验收。

## 真实 provider 配置（示例；未在本仓库调用）

1. 按协议复制 `real/openai-compatible.provider.example.json` 或 `real/anthropic-compatible.provider.example.json` 到仓库外的私人配置目录。
2. 将 `providerId`、`baseURL`、`model` 改为实际值。只有已经确认该模型支持工具调用时，才能保留 `tools: "supported"`。
3. Key 不写入 JSON、命令参数或仓库。Windows 上可先把 Key 放入一个临时环境变量，再导入 Credential Manager；导入完成后立即移除该环境变量：

```powershell
$env:WRITING_AGENT_API_KEY = '<temporary value>'
npm run runtime:cli -- credential set --id openai-primary --from-env WRITING_AGENT_API_KEY
Remove-Item Env:WRITING_AGENT_API_KEY
```

   Anthropic 示例对应的 ID 是 `anthropic-primary`。`credential inspect` 只返回是否配置和存储方式，`credential delete` 精确删除所给 ID；三条命令都不会输出 Key。系统安全存储不可用时，导入命令不会把 Key 写入文件，而会明确返回会话级回退并以失败码结束。
4. 在真实运行前，可在已经取得 API 与费用授权后显式执行小请求能力探测：

```powershell
npm run runtime:cli -- doctor --provider-config '<private-provider-config.json>'
```

   `doctor` 会实际访问配置的 provider，验证认证、模型、流式输出和工具调用，因此可能产生少量费用；没有授权时不要执行。
5. 探测通过后，将上面 mock 命令的 `--provider-config` 换成私人配置文件再执行。

schema v1 的 OpenAI `credentialEnv` 仍可读取并会归一化为 `env:<NAME>`，仅用于兼容旧私人配置；新配置使用 schema v2 的 `managed:<id>`，开发调试也可显式使用 `env:<NAME>`。真实调用成功只表示 provider 完成了本次工具闭环，输出会标记 `real_provider_executed`；它仍是 `publicationReady=false`。文章质量、事实门禁与正式导出分别验收。本仓库 WA-015 验证没有使用真实 Key，也没有产生付费调用。
