// Refresh only source content and hashes; preserve curated metadata and validation status.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const target = resolve(root, 'packages/writing-pack/src/legacy-style-data.json');
const archive = JSON.parse(readFileSync(target, 'utf8'));
for (const source of [archive.registrySource, ...archive.profiles, archive.methodology]) {
  const content = readFileSync(resolve(root, source.sourcePath), 'utf8').replaceAll('\r\n', '\n');
  if (content.includes('\r')) throw new Error(`Unexpected bare CR: ${source.sourcePath}`);
  source.content = content;
  source.sourceHash = createHash('sha256').update(content, 'utf8').digest('hex');
}
archive.registryHash = archive.registrySource.sourceHash;
writeFileSync(target, `${JSON.stringify(archive, null, 2)}\n`, 'utf8');
console.log('Legacy style snapshot regenerated with LF text and matching SHA-256.');
