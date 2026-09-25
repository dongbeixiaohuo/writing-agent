import type { DesktopProviderSetupInput } from './desktop-bridge.js';

export interface ProviderPreset {
  readonly id: string;
  readonly label: string;
  readonly group: '国内服务' | '国际服务' | '聚合平台';
  readonly kind: DesktopProviderSetupInput['kind'];
  readonly baseURL: string;
  readonly modelHint: string;
  readonly note: string;
}

// Data only: these addresses never grant the renderer network access. The host
// continues to own credentials, connection probes and all provider requests.
// Checked 2026-09-21; sources and adapter path conventions are documented in
// docs/implementation/PROVIDER_PRESETS.md. No affiliate links or SDK code copied.
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'minimax-cn', label: 'MiniMax · 国内', group: '国内服务', kind: 'anthropic_compatible',
    baseURL: 'https://api.minimax.cn/anthropic/v1', modelHint: '例如 MiniMax-M3',
    note: '使用 MiniMax 国内开放平台的 Key。旧地址或专用网关可选择自定义配置，已有配置不会自动迁移。' },
  { id: 'deepseek', label: 'DeepSeek', group: '国内服务', kind: 'openai_compatible',
    baseURL: 'https://api.deepseek.com', modelHint: '填写控制台中的完整模型 ID',
    note: '使用 DeepSeek 开放平台的 API Key；请选择支持工具调用的对话模型。' },
  { id: 'qwen-cn', label: '阿里云百炼 / 通义千问 · 北京', group: '国内服务', kind: 'openai_compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', modelHint: '例如 qwen-plus',
    note: '使用北京地域的百炼 API Key，不是 Coding Plan Key。业务空间专属地址可在自定义配置中填写。' },
  { id: 'kimi-cn', label: 'Kimi / 月之暗面 · 国内', group: '国内服务', kind: 'openai_compatible',
    baseURL: 'https://api.moonshot.cn/v1', modelHint: '填写 Kimi 开放平台中的模型 ID',
    note: '使用国内开放平台 API Key；Kimi 网页会员和 Kimi Code 套餐不是这个通用 API 配置。' },
  { id: 'zhipu', label: '智谱 GLM · 通用 API', group: '国内服务', kind: 'openai_compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4', modelHint: '填写智谱控制台中的模型 ID',
    note: '使用智谱开放平台通用 API Key；Coding Plan 的专用接口请按套餐说明使用自定义配置。' },
  { id: 'volcengine', label: '火山方舟 / 豆包 · 通用 API', group: '国内服务', kind: 'openai_compatible',
    baseURL: 'https://ark.cn-beijing.volces.com/api/v3', modelHint: '模型 ID 或推理接入点 ID（ep-…）',
    note: '从方舟控制台复制已开通的模型 ID 或推理接入点 ID；使用通用 API，不是 Coding / Agent Plan 专用地址。' },
  { id: 'openai', label: 'OpenAI', group: '国际服务', kind: 'openai_compatible',
    baseURL: 'https://api.openai.com/v1', modelHint: '填写支持 Chat Completions 的模型 ID',
    note: '使用 OpenAI API 平台的 Key。ChatGPT 订阅不等于 API 额度；仅支持 Responses 的模型不适用此接口。' },
  { id: 'anthropic', label: 'Anthropic / Claude', group: '国际服务', kind: 'anthropic_compatible',
    baseURL: 'https://api.anthropic.com/v1', modelHint: '填写 Claude 控制台中的完整模型 ID',
    note: '使用 Claude API 控制台创建的 Key，不是 Claude 网页订阅或 Claude Code 登录凭据。' },
  { id: 'gemini', label: 'Google Gemini', group: '国际服务', kind: 'openai_compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', modelHint: '填写 AI Studio 中的 Gemini 模型 ID',
    note: '使用 Google AI Studio / Gemini API Key，经 OpenAI 兼容接口连接；不是 Vertex AI 项目凭据。' },
  { id: 'minimax-global', label: 'MiniMax · 国际', group: '国际服务', kind: 'anthropic_compatible',
    baseURL: 'https://api.minimax.io/anthropic/v1', modelHint: '例如 MiniMax-M3',
    note: '使用 MiniMax 国际开放平台的 Key；请与国内账号、Key 区分。' },
  { id: 'qwen-sg', label: '阿里云百炼 / Qwen · 新加坡', group: '国际服务', kind: 'openai_compatible',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', modelHint: '例如 qwen-plus',
    note: '使用新加坡地域的百炼 API Key。北京 Key 不通用；其他地域或业务空间地址使用自定义配置。' },
  { id: 'kimi-global', label: 'Kimi / Moonshot · 国际', group: '国际服务', kind: 'openai_compatible',
    baseURL: 'https://api.moonshot.ai/v1', modelHint: '填写国际开放平台中的模型 ID',
    note: '使用 Kimi 国际开放平台 API Key，不是国内平台 Key 或 Kimi Code 套餐 Key。' },
  { id: 'zai', label: 'Z.AI / GLM · 国际通用 API', group: '国际服务', kind: 'openai_compatible',
    baseURL: 'https://api.z.ai/api/paas/v4', modelHint: '填写 Z.AI 控制台中的模型 ID',
    note: '使用 Z.AI 通用 API Key；Coding Plan 专用接口请使用自定义配置。' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow · 国内', group: '聚合平台', kind: 'openai_compatible',
    baseURL: 'https://api.siliconflow.cn/v1', modelHint: '复制完整模型 ID，保留组织名 / 前缀',
    note: '使用硅基流动国内平台 Key，不是模型原厂的 Key；模型 ID 须保留控制台提供的完整前缀。' },
  { id: 'openrouter', label: 'OpenRouter', group: '聚合平台', kind: 'openai_compatible',
    baseURL: 'https://openrouter.ai/api/v1', modelHint: '完整模型 ID：供应商/模型',
    note: '使用 OpenRouter 的 Key，不是模型原厂的 Key。选择支持工具调用的模型；费用与路由由该平台管理。' },
];

export function applyProviderPreset(form: DesktopProviderSetupInput, id: string): DesktopProviderSetupInput {
  if (id === 'custom') return { ...form, apiKey: '' };
  const preset = PROVIDER_PRESETS.find(candidate => candidate.id === id);
  if (preset === undefined) throw new Error('PROVIDER_PRESET_UNKNOWN');
  return { ...form, kind: preset.kind, providerId: preset.id, baseURL: preset.baseURL,
    model: '', apiKey: '', tools: 'supported', usage: 'reported' };
}

export function identifyProviderPreset(config: Pick<DesktopProviderSetupInput, 'kind' | 'baseURL'>): string {
  // Exact endpoint + protocol only: never infer a provider from its label or a
  // hostname substring. In particular, do not rewrite working legacy endpoints.
  const baseURL = config.baseURL.trim().replace(/\/+$/u, '');
  return PROVIDER_PRESETS.find(preset => preset.kind === config.kind && preset.baseURL === baseURL)?.id ?? 'custom';
}
