import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CredentialBroker } from '../../../packages/runtime/credentials/src/index.js';
import type { SearchSettingsInput, SearchSettingsView } from '../../../packages/client-bridge/src/desktop-bridge.js';
import type { FactSearchConfiguration } from '../../../packages/application/src/fact-search.js';

const flags = z.object({ parallelEnabled: z.boolean(), tavilyEnabled: z.boolean() }).strict();
const inputSchema = flags.extend({ tavilyApiKey: z.string().max(2048).optional() });
export class SearchSettingsStore {
  #flags = { parallelEnabled: false, tavilyEnabled: false };
  readonly #credentialId: string;
  #saving = false;
  constructor(readonly path: string, readonly credentials: CredentialBroker) {
    this.#credentialId = `search-tavily-${createHash('sha256').update(path).digest('hex').slice(0, 24)}`;
    if (existsSync(path)) {
      try { this.#flags = flags.parse(JSON.parse(readFileSync(path, 'utf8'))); }
      catch { throw new Error('SEARCH_SETTINGS_INVALID'); }
    }
  }
  configuration(): FactSearchConfiguration {
    return { ...this.#flags, getTavilyKey: () => this.credentials.resolve(`managed:${this.#credentialId}`) };
  }
  async status(): Promise<SearchSettingsView> {
    const metadata = await this.credentials.inspect(`managed:${this.#credentialId}`);
    return { ...this.#flags, tavilyKeyConfigured: metadata.configured, credentialPersistence: metadata.persistence };
  }
  async save(input: SearchSettingsInput): Promise<SearchSettingsView> {
    if (this.#saving) throw new Error('SEARCH_SETTINGS_BUSY');
    this.#saving = true;
    try {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) throw new Error('SEARCH_SETTINGS_INVALID');
      const key = parsed.data.tavilyApiKey?.trim();
      if (parsed.data.tavilyEnabled && !key && !(await this.credentials.resolve(`managed:${this.#credentialId}`))) throw new Error('SEARCH_API_KEY_REQUIRED');
      if (key) await this.credentials.saveManaged(this.#credentialId, key, 'system');
      const value = { parallelEnabled: parsed.data.parallelEnabled, tavilyEnabled: parsed.data.tavilyEnabled };
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      writeFileSync(temp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.path);
      this.#flags = value;
      return await this.status();
    } finally { this.#saving = false; }
  }
}
