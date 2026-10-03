import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import type { SearchSettingsInput, SearchSettingsView, SearchConnectionView } from '../../../packages/client-bridge/src/desktop-bridge.js';
import { createFactSearchTools, SEARCH_TEST_QUERY, type SearchProvider, type FactSearchConfiguration } from '../../../packages/application/src/fact-search.js';

const flags = z.object({ parallelEnabled: z.boolean(), tavilyEnabled: z.boolean() }).strict();
const inputSchema = flags.extend({ tavilyApiKey: z.string().max(2048).optional() });
export class SearchSettingsStore {
  #flags = { parallelEnabled: false, tavilyEnabled: false };
  readonly #credentialId: string;
  #saving = false;
  #generation = 0;
  #verification: Partial<Record<SearchProvider, SearchConnectionView>> = {};
  #checking = new Set<SearchProvider>();
  constructor(readonly path: string, readonly credentials: CredentialBroker, readonly transport: { fetch?: typeof fetch } = {}) {
    this.#credentialId = `search-tavily-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
    if (existsSync(path)) {
      try { this.#flags = flags.parse(JSON.parse(readFileSync(path, 'utf8'))); }
      catch { throw new Error('SEARCH_SETTINGS_INVALID'); }
    }
  }
  configuration(): FactSearchConfiguration {
    return { ...this.#flags, authorizationMode: 'enabled_services',
      getTavilyKey: () => this.credentials.resolve(`managed:${this.#credentialId}`) };
  }
  async status(): Promise<SearchSettingsView> {
    const metadata = await this.credentials.inspect(`managed:${this.#credentialId}`);
    return { ...this.#flags, tavilyKeyConfigured: metadata.configured, credentialPersistence: metadata.persistence,
      ...(Object.keys(this.#verification).length ? { verification: { ...this.#verification } } : {}) };
  }
  async verify(provider: SearchProvider): Promise<SearchSettingsView> {
    if (provider !== 'parallel' && provider !== 'tavily') throw new Error('SEARCH_SETTINGS_INVALID');
    if (this.#saving || this.#checking.has(provider)) throw new Error('SEARCH_SETTINGS_BUSY');
    this.#checking.add(provider);
    delete this.#verification[provider];
    const generation = this.#generation;
    const startedAt = Date.now();
    try {
      const search = createFactSearchTools({ ...this.transport, configuration: () => ({
        parallelEnabled: provider === 'parallel', tavilyEnabled: provider === 'tavily',
        getTavilyKey: this.configuration().getTavilyKey!,
        // Explicit settings action authorizes only this fixed, public probe; never a manuscript query.
        authorizeQuery: async request => request.query === SEARCH_TEST_QUERY,
      }) });
      const result = await search.search(SEARCH_TEST_QUERY);
      const available = result.mode === 'external' && result.provider === provider;
      const code = result.attempts?.at(-1)?.errorCode ?? result.failureCode;
      const failure = code === 'SEARCH_API_KEY_REQUIRED' ? '未找到已保存的 Tavily Key，请重新配置。'
        : code === 'SEARCH_HTTP_401' || code === 'SEARCH_HTTP_403' ? '服务拒绝认证，请核对 Key 和账户权限。'
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
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new Error('SEARCH_SETTINGS_INVALID');
      const key = parsed.data.tavilyApiKey?.trim();
      const credentialRef = `managed:${this.#credentialId}`;
      if (parsed.data.tavilyEnabled && !key && !(await this.credentials.resolve(credentialRef))) throw new Error('SEARCH_API_KEY_REQUIRED');
      const value = { parallelEnabled: parsed.data.parallelEnabled, tavilyEnabled: parsed.data.tavilyEnabled };
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      let previousKey: string | undefined;
      let previousPersistence: 'system' | 'session' = 'system';
      let keyChanged = false;
      try {
        if (key) {
          previousKey = await this.credentials.resolve(credentialRef);
          if (previousKey !== undefined) {
            const metadata = await this.credentials.inspect(credentialRef);
            if (metadata.persistence === 'session') previousPersistence = 'session';
          }
          await this.credentials.saveManaged(this.#credentialId, key, 'system');
          keyChanged = true;
        }
        renameSync(temp, this.path);
      } catch (error) {
        if (keyChanged) {
          if (previousKey === undefined) await this.credentials.deleteManaged(this.#credentialId);
          else await this.credentials.saveManaged(this.#credentialId, previousKey, previousPersistence);
        }
        throw error;
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
