import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import assert from 'node:assert/strict';
const root = process.cwd(), manifest = JSON.parse(await readFile('package.json', 'utf8'));
const paths = new Set([manifest.main, manifest.types, manifest.dsh.bundle.patch]);
function collect(value) { if (typeof value === 'string') paths.add(value); else for (const item of Object.values(value)) collect(item); }
collect(manifest.exports);
for (const name of paths) {
  assert.equal(typeof name, 'string');
  assert.ok(name.startsWith('./'), 'exports must be package-relative');
  const path = resolve(root, name), rel = relative(root, path);
  assert.ok(!isAbsolute(rel) && !rel.startsWith('..'), 'export must stay inside package');
  assert.ok((await stat(path)).isFile(), 'every export must exist');
}
const host = await import(pathToFileURL(resolve(manifest.main)).href);
assert.equal(typeof host.apply, 'function');
assert.equal(typeof host.Config, 'function');
const { validateTypertManifest } = await import('@deepseek-ai/dsh-typert-loader');
const contribution = await import(pathToFileURL(resolve(manifest.exports['./typert'].default)).href);
assert.equal(validateTypertManifest(manifest.name, contribution.TYPERT).invocations.length, 9);
let registration;
runInNewContext(await readFile('lib/client.js', 'utf8'), { window: { __ModuleLoader__: { load(value) { registration = value; } } }, console });
assert.equal(registration.id, manifest.name);
assert.equal(typeof registration.factory, 'function');
const require = createRequire(import.meta.url);
const client = registration.factory(name => { assert.equal(name, 'react', 'only React is a shared client external'); return require(name); });
assert.equal(typeof client.apply, 'function');
assert.ok(client.inject.includes('slots'));
assert.ok(client.inject.includes('remote'));
const patch = await readFile(manifest.dsh.bundle.patch, 'utf8');
assert.match(patch, /^- insert:/u);
assert.match(patch, /id: llm-opendesign-corouter/u);
assert.match(patch, /name: dsh-opendesign-corouter/u);
console.log(`Package exports, Host entry, lazy Client factory and Bundle patch verified (${paths.size} paths).`);
