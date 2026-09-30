// Reviewed identities, not guesses based on a provider's name or hostname.
// Source: cc-switch da193d4f7a6ce3710623c312245c752376c0d036;
// see docs/implementation/PROVIDER_PRESETS.md for sources and limitations.
export const PROVIDER_REGIONS = { cn: '国内站', international: '国际站', unspecified: '不区分国内 / 国际' } as const;
export const PROVIDER_PRODUCTS = {
  api: '通用 API', coding: 'Coding Plan', token: 'Token Plan', agent: 'Agent Plan',
  step: 'Step Plan', subscription: '订阅套餐', shared: 'API / 套餐共用入口',
  platform: '平台 API（计费见平台）',
} as const;
export const PROVIDER_CHANNELS = { direct: '官方直连', aggregator: '聚合平台', relay: '第三方中转' } as const;
export interface ProviderOffering {
  readonly provider: string;
  readonly region: keyof typeof PROVIDER_REGIONS;
  readonly regionDetail?: string;
  readonly product: keyof typeof PROVIDER_PRODUCTS;
  readonly edition?: string;
  readonly channel: keyof typeof PROVIDER_CHANNELS;
}

type IdentityRow = readonly [ids: readonly string[], provider: string, region: ProviderOffering['region'],
  product: ProviderOffering['product'], channel?: ProviderOffering['channel'], edition?: string | undefined, regionDetail?: string];

const IDENTITIES: readonly IdentityRow[] = [
  [['minimax-cn', 'cc-minimax'], 'MiniMax', 'cn', 'shared', 'direct', 'Token Plan'],
  [['minimax-global', 'cc-minimax-en'], 'MiniMax', 'international', 'shared', 'direct', 'Coding Plan'],
  [['deepseek', 'cc-deepseek', 'deepseek-anthropic'], 'DeepSeek', 'unspecified', 'api'],
  [['qwen-cn', 'cc-qianwenai', 'qwen-cn-anthropic'], '千问 / 阿里云百炼', 'cn', 'api', 'direct', undefined, '北京'],
  [['qwen-sg', 'cc-qwencloud', 'qwen-sg-anthropic'], 'Qwen / 阿里云百炼', 'international', 'api', 'direct', undefined, '新加坡'],
  [['kimi-cn', 'cc-kimi', 'kimi-cn-anthropic'], 'Kimi / 月之暗面', 'cn', 'api'],
  [['kimi-global', 'cc-kimi-global', 'kimi-global-anthropic'], 'Kimi / Moonshot', 'international', 'api'],
  [['cc-kimi-coding'], 'Kimi For Coding', 'cn', 'coding'],
  [['cc-kimi-coding-global'], 'Kimi For Coding', 'international', 'coding'],
  [['zhipu', 'zhipu-anthropic'], '智谱 GLM', 'cn', 'api'],
  [['zai', 'zai-anthropic'], 'Z.AI / GLM', 'international', 'api'],
  [['cc-zhipu-glm', 'zhipu-coding-chat', 'zhipu-coding-anthropic'], '智谱 GLM', 'cn', 'coding'],
  [['cc-zhipu-glm-en', 'zai-coding-chat', 'zai-coding-anthropic'], 'Z.AI / GLM', 'international', 'coding'],
  [['volcengine', 'cc-doubaoseed', 'doubao-anthropic'], '火山方舟 / 豆包', 'cn', 'api', 'direct', undefined, '北京'],
  [['cc-ark-agentplan'], '火山方舟', 'cn', 'agent', 'direct', undefined, '北京'],
  [['cc-ark-codingplan'], '火山方舟', 'cn', 'coding', 'direct', undefined, '北京'],
  [['cc-byteplus'], 'BytePlus ModelArk', 'international', 'coding'],
  [['openai', 'openai-responses'], 'OpenAI', 'international', 'api'],
  [['anthropic'], 'Anthropic / Claude', 'international', 'api'],
  [['gemini'], 'Google Gemini', 'international', 'api'],
  [['siliconflow', 'cc-siliconflow', 'siliconflow-anthropic'], '硅基流动 SiliconFlow', 'cn', 'platform', 'aggregator'],
  [['cc-siliconflow-en', 'siliconflow-en-anthropic'], '硅基流动 SiliconFlow', 'international', 'platform', 'aggregator'],
  [['openrouter', 'cc-openrouter'], 'OpenRouter', 'unspecified', 'platform', 'aggregator'],
  [['cc-qianfan'], '百度千帆', 'cn', 'api'],
  [['cc-qianfan-coding'], '百度千帆', 'cn', 'coding'],
  [['cc-qianfan-tokenplan'], '百度千帆', 'cn', 'token', 'direct', '个人版'],
  [['qwen-cn-coding-anthropic'], '千问 / 阿里云百炼', 'cn', 'coding'],
  [['cc-qwencloud-coding'], 'Qwen / 阿里云百炼', 'international', 'coding'],
  [['cc-qianwenai-token-plan'], '千问AI平台', 'cn', 'token', 'direct', undefined, '北京'],
  [['cc-qwencloud-token-plan'], 'QwenCloud', 'international', 'token', 'direct', undefined, '新加坡'],
  [['cc-hy3-tokenhub'], '腾讯混元 TokenHub', 'cn', 'api'],
  [['cc-tencent-token-plan'], '腾讯云', 'cn', 'token', 'direct', '个人版'],
  [['cc-tencent-token-plan-intl'], '腾讯云', 'international', 'token', 'direct', '个人版'],
  [['cc-tencent-token-plan-enterprise-pro'], '腾讯云', 'cn', 'token', 'direct', '企业专业版 Pro'],
  [['cc-tencent-token-plan-enterprise-pro-intl'], '腾讯云', 'international', 'token', 'direct', '企业专业版 Pro'],
  [['cc-tencent-token-plan-enterprise-lite'], '腾讯云', 'cn', 'token', 'direct', '企业轻量版 Lite'],
  [['cc-tencent-token-plan-enterprise-lite-intl'], '腾讯云', 'international', 'token', 'direct', '企业轻量版 Lite'],
  [['cc-stepfun-api'], '阶跃星辰 StepFun', 'cn', 'api'],
  [['cc-stepfun-api-en'], '阶跃星辰 StepFun', 'international', 'api'],
  [['cc-stepfun'], '阶跃星辰 StepFun', 'cn', 'step'],
  [['cc-stepfun-en'], '阶跃星辰 StepFun', 'international', 'step'],
  [['cc-longcat'], '美团 LongCat', 'unspecified', 'api'],
  [['cc-astron-coding-plan'], '讯飞星辰 Astron', 'cn', 'coding', 'direct', undefined, '华北'],
  [['cc-bailing'], '蚂蚁百灵 BaiLing', 'unspecified', 'api'],
  [['cc-xiaomi-mimo'], '小米 MiMo', 'unspecified', 'api'],
  [['cc-xiaomi-mimo-token-plan'], '小米 MiMo', 'cn', 'token'],
  [['cc-xai'], 'xAI / Grok', 'international', 'api'],
  [['cc-fluxa-tokenplan'], 'FluxA / 百度千帆', 'international', 'token', 'aggregator', 'Team'],
  [['cc-compshare-coding'], '优刻得 Compshare', 'unspecified', 'coding', 'aggregator'],
  [['cc-opencode-go'], 'OpenCode Go', 'unspecified', 'subscription', 'relay'],
  [['cc-compshare'], '优刻得 Compshare', 'unspecified', 'platform', 'aggregator'],
  [['cc-shengsuanyun'], '胜算云 Shengsuanyun', 'unspecified', 'platform', 'aggregator'],
  [['cc-qiniu'], '七牛云 Qiniu', 'unspecified', 'platform', 'aggregator'],
  [['cc-jiekou'], '接口 AI / JieKou AI', 'unspecified', 'platform', 'aggregator'],
  [['cc-modelscope'], '魔搭 ModelScope', 'unspecified', 'platform', 'aggregator'],
];

const reviewed = new Map<string, ProviderOffering>();
for (const [ids, provider, region, product, channel = 'direct', edition, regionDetail] of IDENTITIES) {
  for (const id of ids) {
    if (reviewed.has(id)) throw new Error(`PROVIDER_IDENTITY_DUPLICATE: ${id}`);
    reviewed.set(id, { provider, region, product, channel,
      ...(edition ? { edition } : {}), ...(regionDetail ? { regionDetail } : {}) });
  }
}

export function providerOffering(id: string, sourceName?: string, category?: 'aggregator' | 'third_party' | 'cn_official'): ProviderOffering {
  const known = reviewed.get(id);
  if (known) return known;
  // Source category is evidence of channel, not of region, billing or plan eligibility.
  if (!sourceName || (category !== 'aggregator' && category !== 'third_party')) {
    throw new Error(`PROVIDER_IDENTITY_REVIEW_REQUIRED: ${id}`);
  }
  return { provider: sourceName, region: 'unspecified', product: 'platform',
    channel: category === 'aggregator' ? 'aggregator' : 'relay' };
}

export function providerRegionLabel(offering: ProviderOffering): string {
  return PROVIDER_REGIONS[offering.region] + (offering.regionDetail ? ` · ${offering.regionDetail}` : '');
}

export function providerProductLabel(offering: ProviderOffering): string {
  if (offering.product === 'shared') return `API / ${offering.edition ?? '套餐'} 共用入口`;
  return PROVIDER_PRODUCTS[offering.product] + (offering.edition ? ` · ${offering.edition}` : '');
}
