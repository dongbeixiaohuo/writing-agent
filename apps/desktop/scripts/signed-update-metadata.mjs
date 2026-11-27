import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js'

const directory = process.argv[2]
if (!directory) throw new Error('Specify the directory containing the signed installer.')
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const name = `Writing-Agent-Setup-${version}-x64.exe`
const installer = join(directory, name)
// Always use an external blockmap. Appending it to the PE would invalidate the signature.
const { size, sha512 } = await buildBlockMap(installer, 'gzip', `${installer}.blockmap`)
await writeFile(join(directory, 'latest.yml'), [
  `version: ${version}`,
  'files:',
  `  - url: ${name}`,
  `    sha512: ${sha512}`,
  `    size: ${size}`,
  `path: ${name}`,
  `sha512: ${sha512}`,
  `releaseDate: '${new Date().toISOString()}'`,
  '',
].join('\n'), 'utf8')
