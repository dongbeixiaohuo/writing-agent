import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { StyleDraftSchema, StyleProfileSchema, validateStyleSamples, type StyleDraft, type StyleProfile, type StyleProfileSummary } from '../../writing-core/src/style-profile.js';

/** Workspace-local library. Applied briefs keep their own immutable card snapshot. */
export class StyleProfileStore {
  constructor(private readonly database: DatabaseSync, private readonly readOnly = false) {}

  list(): StyleProfileSummary[] {
    return this.database.prepare('SELECT profile_json FROM style_profiles WHERE deleted = 0 ORDER BY rowid DESC').all().map(row => {
      const p = StyleProfileSchema.parse(JSON.parse(row.profile_json as string));
      return { id: p.id, name: p.name, version: p.version, updatedAt: p.updatedAt, sampleCount: p.sampleCount, summary: p.summary };
    });
  }

  get(id: string): StyleProfile {
    const row = this.database.prepare('SELECT profile_json FROM style_profiles WHERE id = ? AND deleted = 0').get(id);
    if (!row) throw new Error('STYLE_PROFILE_NOT_FOUND');
    return StyleProfileSchema.parse(JSON.parse(row.profile_json as string));
  }

  save(id: string | null, expectedVersion: number | null, value: StyleDraft): StyleProfile {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    const draft = StyleDraftSchema.parse(value);
    const samples = validateStyleSamples(draft.samples);
    if (draft.sampleCount !== samples.length) throw new Error('STYLE_INPUT_INVALID');
    // A user may edit the card, never manufacture a quotation in the analysis record.
    for (const rule of draft.rules) {
      for (const evidence of rule.evidence) {
        if (!samples.find(sample => sample.id === evidence.sampleId)?.text.includes(evidence.quote)) throw new Error('STYLE_EVIDENCE_INVALID');
      }
    }
    if (id === null && expectedVersion !== null || id !== null && expectedVersion === null) throw new Error('STYLE_VERSION_CONFLICT');
    if (id === null && this.list().length >= 50) throw new Error('STYLE_LIBRARY_FULL');
    const profile: StyleProfile = { ...draft, samples, id: id ?? randomUUID(), version: (expectedVersion ?? 0) + 1, updatedAt: new Date().toISOString() };
    const json = JSON.stringify(profile);
    if (id === null) {
      this.database.prepare('INSERT INTO style_profiles(id, version, profile_json) VALUES (?, ?, ?)').run(profile.id, profile.version, json);
    } else {
      const result = this.database.prepare('UPDATE style_profiles SET version = ?, profile_json = ? WHERE id = ? AND version = ? AND deleted = 0').run(profile.version, json, id, expectedVersion!);
      if (result.changes !== 1) throw new Error('STYLE_VERSION_CONFLICT');
    }
    return this.get(profile.id);
  }

  remove(id: string, expectedVersion: number): void {
    if (this.readOnly) throw new Error('STORAGE_READ_ONLY');
    const result = this.database.prepare('UPDATE style_profiles SET deleted = 1 WHERE id = ? AND version = ? AND deleted = 0').run(id, expectedVersion);
    if (result.changes !== 1) throw new Error('STYLE_VERSION_CONFLICT');
  }
}
