import type { DesktopProviderSetupInput } from './desktop-bridge.js';
import { CC_SWITCH_CODEX_PRESETS } from './cc-switch-codex-presets.js';
import { providerOffering, providerProductLabel, providerRegionLabel, PROVIDER_CHANNELS, type ProviderOffering } from './provider-offerings.js';
export { PROVIDER_REGIONS, PROVIDER_PRODUCTS, PROVIDER_CHANNELS, providerProductLabel, providerRegionLabel } from './provider-offerings.js';

export const PROVIDER_PRESET_GROUPS = ['国内服务', '国际服务', '官方服务（不区分地区）', '套餐专用接口', 'API / 套餐共用入口', '聚合平台', '第三方中转'] as const;
export const PROVIDER_PROTOCOL_LABELS = {
  openai_compatible: 'OpenAI Chat Completions',
  openai_responses: 'OpenAI Responses',
  anthropic_compatible: 'Anthropic Messages',
} as const;

export interface ProviderPreset {
  readonly offering: ProviderOffering;
  readonly id: string;
  readonly label: string;
  readonly group: typeof PROVIDER_PRESET_GROUPS[number];
  readonly kind: DesktopProviderSetupInput['kind'];
  readonly baseURL: string;
  readonly modelHint: string;
  readonly note: string;
  readonly modelExamples?: readonly string[];
  readonly sourceNames?: readonly string[];
  readonly authHeader?: 'authorization' | 'x-api-key';
  // Vendor-specific request fields the adapter adds to every request body.
  // Product-level adaptations reviewed per preset; never user-editable.
  readonly extraBody?: Readonly<Record<string, unknown>>;
}

// Data only: these addresses never grant the renderer network access. The host
// continues to own credentials, connection probes and all provider requests.
// Checked 2026-09-21; sources and adapter path conventions are documented in
// docs/implementation/PROVIDER_PRESETS.md. No affiliate links or SDK code copied.
const EXISTING_PROVIDER_PRESETS: readonly Omit<ProviderPreset, 'offering'>[] = [
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
    note: '这是智谱通用 API，不是 Coding Plan。套餐用户请选择明确标注 Coding Plan 的预设。' },
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
    note: '这是 Z.AI 国际站通用 API，不是 Coding Plan。套餐用户请选择国际站 Coding Plan 预设。' },
  { id: 'siliconflow', label: '硅基流动 SiliconFlow · 国内', group: '聚合平台', kind: 'openai_compatible',
    baseURL: 'https://api.siliconflow.cn/v1', modelHint: '复制完整模型 ID，保留组织名 / 前缀',
    note: '使用硅基流动国内平台 Key，不是模型原厂的 Key；模型 ID 须保留控制台提供的完整前缀。' },
  { id: 'openrouter', label: 'OpenRouter', group: '聚合平台', kind: 'openai_compatible',
    baseURL: 'https://openrouter.ai/api/v1', modelHint: '完整模型 ID：供应商/模型',
    note: '使用 OpenRouter 的 Key，不是模型原厂的 Key。选择支持工具调用的模型；费用与路由由该平台管理。' },
];

// Supplemental protocol variants from the same pinned cc-switch revision:
// OpenCode provides Chat bases; Claude provides SDK bases (append /v1 for our
// /messages adapter). ANTHROPIC_AUTH_TOKEN means Bearer, not x-api-key.
const PLAN_VARIANTS = [
  { id: 'zhipu-coding-chat', kind: 'openai_compatible', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4', modelExamples: ['glm-5.3', 'glm-5-turbo'] },
  { id: 'zai-coding-chat', kind: 'openai_compatible', baseURL: 'https://api.z.ai/api/coding/paas/v4', modelExamples: ['glm-5.3'] },
  { id: 'zhipu-coding-anthropic', kind: 'anthropic_compatible', baseURL: 'https://open.bigmodel.cn/api/anthropic/v1', modelExamples: ['glm-5.3'], authHeader: 'authorization' },
  { id: 'zai-coding-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.z.ai/api/anthropic/v1', modelExamples: ['glm-5.3'], authHeader: 'authorization' },
  { id: 'qwen-cn-coding-anthropic', kind: 'anthropic_compatible', baseURL: 'https://coding.dashscope.aliyuncs.com/apps/anthropic/v1', modelExamples: [], authHeader: 'authorization' },
] as const;

// General-API Anthropic Messages variants from the same pinned cc-switch
// revision (claudeProviderPresets.ts): the user only fills a Key; protocol
// and endpoint come from the preset. These are the DEFAULT choices for their
// provider families (see ANTHROPIC_PREFERRED_PRESETS); the Chat/Responses
// variants stay registered for existing configs but are hidden from new
// selections. ANTHROPIC_AUTH_TOKEN means Bearer. The adapter appends /v1 to
// these bases; endpoints are configuration metadata, not verified accounts.
const ANTHROPIC_VARIANTS = [
  { id: 'deepseek-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.deepseek.com/anthropic',
    modelExamples: ['deepseek-flash', 'deepseek-v4-pro'], authHeader: 'authorization',
    // Endpoint-level evidence (user's own truncation + upstream tool_choice
    // rejection): DeepSeek thinking must be disabled for this app's required
    // tool calls, on every wire protocol.
    extraBody: { thinking: { type: 'disabled' } } },
  { id: 'kimi-cn-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.moonshot.cn/anthropic',
    modelExamples: ['kimi-k2.7-code'], authHeader: 'authorization' },
  { id: 'kimi-global-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.moonshot.ai/anthropic',
    modelExamples: ['kimi-k2.7-code'], authHeader: 'authorization' },
  { id: 'zhipu-anthropic', kind: 'anthropic_compatible', baseURL: 'https://open.bigmodel.cn/api/anthropic',
    modelExamples: ['glm-5.3'], authHeader: 'authorization' },
  { id: 'zai-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.z.ai/api/anthropic',
    modelExamples: ['glm-5.3'], authHeader: 'authorization' },
  { id: 'qwen-cn-anthropic', kind: 'anthropic_compatible', baseURL: 'https://dashscope.aliyuncs.com/apps/anthropic',
    modelExamples: ['qwen3.8-max', 'qwen3.8-flash'], authHeader: 'authorization' },
  { id: 'qwen-sg-anthropic', kind: 'anthropic_compatible', baseURL: 'https://dashscope-intl.aliyuncs.com/apps/anthropic',
    modelExamples: ['qwen3.8-max', 'qwen3.8-flash'], authHeader: 'authorization' },
  { id: 'doubao-anthropic', kind: 'anthropic_compatible', baseURL: 'https://ark.cn-beijing.volces.com/api/compatible',
    modelExamples: ['doubao-seed-2-1-pro-260628'], authHeader: 'authorization' },
  { id: 'siliconflow-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.siliconflow.cn',
    modelExamples: ['Pro/MiniMaxAI/MiniMax-M2.5'], authHeader: 'authorization' },
  { id: 'siliconflow-en-anthropic', kind: 'anthropic_compatible', baseURL: 'https://api.siliconflow.com',
    modelExamples: ['MiniMaxAI/MiniMax-M3'], authHeader: 'authorization' },
] as const;

// Reviewed vendor-specific request fields per preset (adapter merges them
// additively into every request body; protocol fields win on collision).
const PRESET_EXTRA_BODY: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // DeepSeek's thinking mode (default on deepseek-flash) rejects
  // tool_choice="required" — verified 2026-09-26 via upstream error "Thinking
  // mode does not support this tool_choice". This app's stage submissions and
  // connection probe always require tool calls, so DeepSeek must run with
  // thinking disabled. See docs/implementation/PROVIDER_PRESETS.md (rc.45).
  'cc-deepseek': { thinking: { type: 'disabled' } },
  'deepseek': { thinking: { type: 'disabled' } },
};

function describePreset(data: Omit<ProviderPreset, 'offering' | 'label' | 'group'>, offering: ProviderOffering): ProviderPreset {
  const plan = ['coding', 'token', 'agent', 'step', 'subscription'].includes(offering.product);
  const group: ProviderPreset['group'] = offering.product === 'shared' ? 'API / 套餐共用入口'
    : plan ? '套餐专用接口' : offering.channel === 'aggregator' ? '聚合平台'
    : offering.channel === 'relay' ? '第三方中转' : offering.region === 'cn' ? '国内服务'
    : offering.region === 'international' ? '国际服务' : '官方服务（不区分地区）';
  const productNote = offering.product === 'shared'
    ? 'API 与套餐共用地址，按账号与 Key 的权益计费；选择此预设不会开通套餐，连接验证也不验证扣费方式。请确认套餐允许用于本写作应用。'
    : plan ? '须使用对应套餐及地区的 Key，并确认套餐允许用于本写作应用；不等同于通用 API。共用地址的不同档位按账号权益区分，选择预设不会变更套餐。'
    : '通用 API 与网页会员、编程订阅不等同；计费及可用模型以此平台的账号权益为准。';
  const channelNote = offering.channel === 'direct' ? '' : '内容和 API Key 会发送到此平台。请使用该平台的 Key，不要填写其他平台或原厂的 Key。';
  const regionNote = offering.region === 'unspecified' ? '目录不拆分国内 / 国际入口；实际可用地区和账号权益以服务商为准。' : '国内站与国际站的账号、Key 和套餐可能不通用。';
  return { ...data, offering, group,
    label: `${offering.provider} · ${providerRegionLabel(offering)} · ${providerProductLabel(offering)} · ${PROVIDER_PROTOCOL_LABELS[data.kind]}`,
    note: [data.note, productNote, regionNote, channelNote].filter(Boolean).join(' '),
    ...(PRESET_EXTRA_BODY[data.id] === undefined ? {} : { extraBody: PRESET_EXTRA_BODY[data.id] }) };
}

function completeProviderCatalog(): readonly ProviderPreset[] {
  // Keep legacy IDs/protocols and saved profiles untouched. Offering identity
  // must NOT be coalesced by endpoint: multiple account plans share addresses.
  const catalog: ProviderPreset[] = [...EXISTING_PROVIDER_PRESETS, {
    id: 'openai-responses', label: 'OpenAI · Responses', group: '国际服务', kind: 'openai_responses' as const,
    baseURL: 'https://api.openai.com/v1', modelHint: '填写支持 Responses 的模型 ID',
    note: '使用 OpenAI API Key，不是 ChatGPT/Codex 订阅登录。已有 Chat Completions 配置不会自动改变。',
  }].map(data => describePreset(data, providerOffering(data.id)));
  for (const [id, name, apiFormat, baseURL, modelExamples, category] of CC_SWITCH_CODEX_PRESETS) {
    const kind = apiFormat === 'openai_chat' ? 'openai_compatible' : 'openai_responses';
    // The only reviewed alias: same supplier, region, product and wire format.
    const index = id === 'cc-siliconflow' ? catalog.findIndex(item => item.id === 'siliconflow') : -1;
    if (index >= 0) {
      const previous = catalog[index]!;
      catalog[index] = { ...previous,
        modelExamples: [...new Set([...(previous.modelExamples ?? []), ...modelExamples])],
        sourceNames: [...(previous.sourceNames ?? []), name] };
      continue;
    }
    catalog.push(describePreset({ id, kind, baseURL, modelExamples, sourceNames: [name],
      modelHint: `例如 ${modelExamples[0]}（以账号可用 ID 为准）`,
      note: '配置资料来自 cc-switch，收录不代表连接已验证。' }, providerOffering(id, name, category)));
  }
  for (const data of PLAN_VARIANTS) catalog.push(describePreset({ ...data,
    modelHint: '填写对应套餐控制台中的完整模型 ID',
    note: '配置资料来自 cc-switch 的 Claude / OpenCode 预设，收录不代表连接已验证。' }, providerOffering(data.id)));
  for (const data of ANTHROPIC_VARIANTS) catalog.push(describePreset({ ...data,
    modelHint: `例如 ${data.modelExamples[0]}（以账号可用 ID 为准）`,
    note: 'Anthropic Messages 协议变体，配置资料来自 cc-switch 的 Claude 预设，收录不代表连接已验证。' }, providerOffering(data.id)));
  return catalog;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = completeProviderCatalog();

// Explicitly reviewed SAME-OFFERING pairs, not a brand-wide protocol upgrade.
// Keep the complete registry for saved configs; simplify only new selections.
// No credentials, endpoints or models are migrated by this preference.
// Every mapped target is Responses. (Pairs whose family gained an Anthropic
// default in rc.49 — DeepSeek, Kimi, GLM, Qwen, Doubao, Zhipu Coding — were
// retired from this map and are governed by ANTHROPIC_PREFERRED_PRESETS.)
export const RESPONSES_PREFERRED_OVER_CHAT: Readonly<Record<string, string>> = {
  openai: 'openai-responses', openrouter: 'cc-openrouter',
};

// Unified-experience preference (rc.49): for provider families that have an
// Anthropic Messages variant, the Anthropic variant is THE default preset —
// users only fill a Key and never pick a protocol or endpoint. The Chat and
// Responses variants of the same families stay registered for existing
// configs but are hidden from new selections. Providers without an Anthropic
// endpoint (OpenAI, Gemini, aggregators) keep their existing defaults.
export const ANTHROPIC_PREFERRED_PRESETS: Readonly<Record<string, string>> = {
  'deepseek': 'deepseek-anthropic', 'cc-deepseek': 'deepseek-anthropic',
  'kimi-cn': 'kimi-cn-anthropic', 'cc-kimi': 'kimi-cn-anthropic',
  'kimi-global': 'kimi-global-anthropic', 'cc-kimi-global': 'kimi-global-anthropic',
  'zhipu': 'zhipu-anthropic', 'cc-zhipu-glm': 'zhipu-anthropic',
  'zai': 'zai-anthropic', 'cc-zhipu-glm-en': 'zai-anthropic',
  'zhipu-coding-chat': 'zhipu-coding-anthropic', 'zai-coding-chat': 'zai-coding-anthropic',
  'qwen-cn': 'qwen-cn-anthropic', 'cc-qianwenai': 'qwen-cn-anthropic',
  'qwen-sg': 'qwen-sg-anthropic', 'cc-qwencloud': 'qwen-sg-anthropic',
  'volcengine': 'doubao-anthropic', 'cc-doubaoseed': 'doubao-anthropic',
  'siliconflow': 'siliconflow-anthropic',
};
export const PREFERRED_PROVIDER_PRESETS = PROVIDER_PRESETS.filter(item =>
  !Object.hasOwn(RESPONSES_PREFERRED_OVER_CHAT, item.id) && !Object.hasOwn(ANTHROPIC_PREFERRED_PRESETS, item.id));

const searchAliases: Readonly<Record<string, string>> = {
  DeepSeek: '深度求索', '千问 / 阿里云百炼': '通义 Qwen', 'Qwen / 阿里云百炼': '通义 千问',
  '千问AI平台': '通义 Qwen 百炼', QwenCloud: '通义 千问 百炼',
  'Z.AI / GLM': '智谱 ZAI', 'Kimi / Moonshot': '月之暗面',
};
const searchIndex = new Map(PROVIDER_PRESETS.map(item => [item.id,
  [item.label, item.id, PROVIDER_CHANNELS[item.offering.channel], searchAliases[item.offering.provider] ?? '',
    ...(item.sourceNames ?? []), ...(item.modelExamples ?? [])].join(' ').toLocaleLowerCase()]));

export function filterProviderPresets(query: string, filters: { region?: string; product?: string } = {}): readonly ProviderPreset[] {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean);
  return PREFERRED_PROVIDER_PRESETS.filter(item => (!filters.region || item.offering.region === filters.region)
    && (!filters.product || item.offering.product === filters.product)
    && terms.every(term => searchIndex.get(item.id)!.includes(term)));
}

export function applyProviderPreset(form: DesktopProviderSetupInput, id: string): DesktopProviderSetupInput {
  if (id === 'custom') return { ...form, apiKey: '' };
  const preset = PROVIDER_PRESETS.find(candidate => candidate.id === id);
  if (preset === undefined) throw new Error('PROVIDER_PRESET_UNKNOWN');
  return { ...form, kind: preset.kind, providerId: preset.id, baseURL: preset.baseURL,
    model: '', apiKey: '', tools: 'supported', usage: 'reported' };
}

export function identifyProviderPreset(config: Pick<DesktopProviderSetupInput, 'kind' | 'baseURL'> & { providerId?: string }): string {
  // Exact endpoint + protocol only: never infer a provider from its label or a
  // hostname substring. In particular, do not rewrite working legacy endpoints.
  const baseURL = config.baseURL.trim().replace(/\/+$/u, '');
  const matches = PROVIDER_PRESETS.filter(preset => preset.kind === config.kind && preset.baseURL === baseURL);
  // A saved ID identifies the chosen preset, never the Key's verified billing
  // entitlement. Without an explicit match, shared endpoints are ambiguous.
  const chosen = matches.find(preset => preset.id === config.providerId);
  if (chosen) return chosen.id;
  if (matches.length > 1) return 'custom';
  return matches[0]?.id ?? 'custom';
}
