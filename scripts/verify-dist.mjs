// Validate npm's actual publication list, then write the local/CI checksum.
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const packed = JSON.parse(await readFile('dist/pack.json', 'utf8'));
assert.ok(Array.isArray(packed) && packed.length === 1, 'Expected one npm package');
const publication = packed[0];
assert.equal(publication.name, manifest.name);
assert.equal(publication.version, manifest.version);
const filename = `${manifest.name}-${manifest.version}.tgz`;
assert.equal(publication.filename, filename);
assert.equal(basename(filename), filename);
const files = new Set(publication.files.map(file => file.path));
const publicRoot = new Set(['package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'SECURITY.md', 'THIRD_PARTY_NOTICES.md']);
for (const file of files) {
  assert.ok(typeof file === 'string' && !file.includes('..') && !file.includes('\\'), 'Unsafe package path');
  assert.ok(publicRoot.has(file) || /^lib\/[A-Za-z0-9_./-]+\.(?:js|map|ts)$/u.test(file), `Unexpected publication file: ${file}`);
}
function verifyExport(value) {
  if (typeof value === 'string') {
    assert.ok(value.startsWith('./') && files.has(value.slice(2)), `Missing publication export: ${value}`);
  } else for (const item of Object.values(value)) verifyExport(item);
}
verifyExport(manifest.exports);
for (const entry of [manifest.main, manifest.types, manifest.dsh.bundle.patch]) verifyExport(entry);
const target = resolve('dist', filename);
assert.ok((await stat(target)).isFile());
const bytes = await readFile(target);
assert.equal(bytes.length, publication.size);
const hash = createHash('sha256').update(bytes).digest('hex');
await writeFile(`${target}.sha256`, `${hash}  ${filename}\n`);
console.log(`Verified ${filename}: ${files.size} publication files, ${bytes.length} bytes; SHA256 ${hash}`);
