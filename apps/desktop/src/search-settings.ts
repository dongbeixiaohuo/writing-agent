import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import type { SearchSettingsInput, SearchSettingsView, SearchConnectionView } from '../../../packages/client-bridge/src/desktop-bridge.js';
import { createFactSearchTools, SEARCH_TEST_QUERY, FACT_SEARCH_LIMIT, MAX_FACT_SEARCH_LIMIT, type SearchProvider, type FactSearchConfiguration } from '../../../packages/application/src/fact-search.js';

const flags = z.object({ parallelEnabled: z.boolean(), tavilyEnabled: z.boolean(), deepseekEnabled: z.boolean().default(false),
  searchLimit: z.number().int().min(1).max(MAX_FACT_SEARCH_LIMIT).default(FACT_SEARCH_LIMIT) }).strict();
const inputSchema = flags.extend({ tavilyApiKey: z.string().max(2048).optional(), deepseekApiKey: z.string().max(2048).optional() });
export class SearchSettingsStore {
  #flags = { parallelEnabled: false, tavilyEnabled: false, deepseekEnabled: false, searchLimit: FACT_SEARCH_LIMIT };
  readonly #credentialId: string;
  readonly #deepseekCredentialId: string;
  #saving = false;
  #generation = 0;
  #verification: Partial<Record<SearchProvider, SearchConnectionView>> = {};
  #checking = new Set<SearchProvider>();
  constructor(readonly path: string, readonly credentials: CredentialBroker, readonly transport: { fetch?: typeof fetch } = {}) {
    this.#credentialId = `search-tavily-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
    this.#deepseekCredentialId = `search-deepseek-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
    if (existsSync(path)) {
      try { this.#flags = flags.parse(JSON.parse(readFileSync(path, 'utf8'))); }
      catch { throw new Error('SEARCH_SETTINGS_INVALID'); }
    }
  }
  configuration(): FactSearchConfiguration {
    return { ...this.#flags, authorizationMode: 'enabled_services',
      getTavilyKey: () => this.credentials.resolve(`managed:${this.#credentialId}`),
      getDeepSeekKey: () => this.credentials.resolve(`managed:${this.#deepseekCredentialId}`) };
  }
  async status(): Promise<SearchSettingsView> {
    const metadata = await this.credentials.inspect(`managed:${this.#credentialId}`);
    const deepseek = await this.credentials.inspect(`managed:${this.#deepseekCredentialId}`);
    return { ...this.#flags, tavilyKeyConfigured: metadata.configured, deepseekKeyConfigured: deepseek.configured,
      credentialPersistence: metadata.persistence === 'session' || deepseek.persistence === 'session' ? 'session'
        : metadata.configured ? metadata.persistence : deepseek.persistence,
      ...(Object.keys(this.#verification).length ? { verification: { ...this.#verification } } : {}) };
  }
  async verify(provider: SearchProvider): Promise<SearchSettingsView> {
    if (!['deepseek', 'parallel', 'tavily'].includes(provider)) throw new Error('SEARCH_SETTINGS_INVALID');
    if (this.#saving || this.#checking.has(provider)) throw new Error('SEARCH_SETTINGS_BUSY');
    this.#checking.add(provider);
    delete this.#verification[provider];
    const generation = this.#generation;
    const startedAt = Date.now();
    try {
      const search = createFactSearchTools({ ...this.transport, configuration: () => ({
        parallelEnabled: provider === 'parallel', tavilyEnabled: provider === 'tavily',
        deepseekEnabled: provider === 'deepseek', getDeepSeekKey: this.configuration().getDeepSeekKey!,
        getTavilyKey: this.configuration().getTavilyKey!,
        // Explicit settings action authorizes only this fixed, public probe; never a manuscript query.
        authorizeQuery: async request => request.query === SEARCH_TEST_QUERY,
      }) });
      const result = await search.search(SEARCH_TEST_QUERY);
      const available = result.mode === 'external' && result.provider === provider;
      const code = result.attempts?.at(-1)?.errorCode ?? result.failureCode;
      const failure = code === 'SEARCH_API_KEY_REQUIRED' ? `未找到已保存的 ${provider === 'deepseek' ? 'DeepSeek' : 'Tavily'} Key，请重新配置。`
        : code === 'SEARCH_HTTP_401' || code === 'SEARCH_HTTP_403' ? '服务拒绝认证，请核对 Key 和账户权限。'
        : code === 'SEARCH_HTTP_402' ? '搜索账户余额不足，请检查服务商账户。'
        : code === 'SEARCH_HTTP_429' ? '服务限流或配额不足，请稍后重试或检查账户。'
        : code?.includes('TIMEOUT') ? '连接或搜索响应超时，未验证可用。'
        : '未收到有效搜索响应，未验证可用。';
      if (generation === this.#generation) this.#verification[provider] = {
        status: available ? 'available' : 'failed', checkedAt: new Date().toISOString(), elapsedMs: Date.now() - startedAt,
        message: available ? '固定公开检索测试成功；仅代表本次连接，不保证后续请求一直可用。' : `${failure}${code ? `（${code}）` : ''}`,
      };
      return await this.status();
    } finally { this.#checking.delete(provider); }
  }
  async save(input: SearchSettingsInput): Promise<SearchSettingsView> {
    if (this.#saving) throw new Error('SEARCH_SETTINGS_BUSY');
    this.#saving = true;
    try {
      const parsed = inputSchema.safeParse({ ...input,
        ...(input.deepseekEnabled === undefined ? { deepseekEnabled: this.#flags.deepseekEnabled } : {}),
        ...(input.searchLimit === undefined ? { searchLimit: this.#flags.searchLimit } : {}) });
      if (!parsed.success) throw new Error('SEARCH_SETTINGS_INVALID');
      const updates = [
        { id: this.#credentialId, key: parsed.data.tavilyApiKey?.trim(), enabled: parsed.data.tavilyEnabled },
        { id: this.#deepseekCredentialId, key: parsed.data.deepseekApiKey?.trim(), enabled: parsed.data.deepseekEnabled },
      ];
      for (const update of updates) {
        if (update.enabled && !update.key && !(await this.credentials.resolve(`managed:${update.id}`))) throw new Error('SEARCH_API_KEY_REQUIRED');
      }
      const value = { parallelEnabled: parsed.data.parallelEnabled, tavilyEnabled: parsed.data.tavilyEnabled,
        deepseekEnabled: parsed.data.deepseekEnabled, searchLimit: parsed.data.searchLimit };
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      const changed: Array<{ id: string; key: string | undefined; persistence: 'system' | 'session' }> = [];
      try {
        for (const update of updates) {
          if (!update.key) continue;
          const previousKey = await this.credentials.resolve(`managed:${update.id}`);
          const metadata = await this.credentials.inspect(`managed:${update.id}`);
          const previousPersistence = metadata.persistence === 'session' ? 'session' : 'system';
          await this.credentials.saveManaged(update.id, update.key, 'system');
          changed.push({ id: update.id, key: previousKey, persistence: previousPersistence });
        }
        renameSync(temp, this.path);
      } catch {
        const rollbackFailures: string[] = [];
        for (const previous of changed.reverse()) {
          try {
            if (previous.key === undefined) await this.credentials.deleteManaged(previous.id);
            else await this.credentials.saveManaged(previous.id, previous.key, previous.persistence);
          } catch {
            // Continue restoring the other credential; backend errors may contain secrets.
            rollbackFailures.push('CREDENTIAL_ROLLBACK_FAILED');
          }
        }
        if (rollbackFailures.length) {
          this.#generation++;
          this.#verification = {};
        }
        throw new Error(rollbackFailures.length ? 'SEARCH_SETTINGS_ROLLBACK_FAILED' : 'SEARCH_SETTINGS_SAVE_FAILED');
      } finally {
        try { unlinkSync(temp); } catch { /* renamed or never created */ }
      }
      this.#flags = value;
      this.#generation++;
      // Availability is session-local and tied to the tested configuration, never inferred from a saved key.
      this.#verification = {};
      return await this.status();
    } finally { this.#saving = false; }
  }
}
