import assert from 'node:assert/strict';
import { readFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateRelease(pkg, env) {
  assert.equal(pkg.name, 'dsh-opendesign-corouter', 'Unexpected package');
  assert.match(pkg.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Release tags support stable semver only');
  assert.equal(pkg.license, 'MIT');
  assert.notEqual(pkg.private, true);
  assert.equal(env.GITHUB_REPOSITORY, 'KouzakiUmi/dsh-opendesign-corouter');
  assert.equal(env.GITHUB_REF_TYPE, 'tag', 'Select a release tag, not a branch');
  assert.equal(env.GITHUB_REF_NAME, `v${pkg.version}`, 'Tag must equal package version');
  return `${pkg.name}-${pkg.version}.tgz`;
}

export function publicationState(document, pkg, integrity) {
  assert.equal(document.name, pkg.name, 'Unexpected registry package');
  assert.ok(document.versions && typeof document.versions === 'object' && !Array.isArray(document.versions), 'Invalid registry response');
  if (!Object.hasOwn(document.versions, pkg.version)) {
    const latest = document['dist-tags']?.latest;
    const placeholderOnly = latest === '0.0.0-stage' && Object.keys(document.versions).every(version => version === latest);
    if (latest && !placeholderOnly) {
      assert.match(latest, /^\d+\.\d+\.\d+$/, 'Review the latest release channel before publishing');
      const current = pkg.version.split('.').map(BigInt), previous = latest.split('.').map(BigInt);
      const index = current.findIndex((value, i) => value !== previous[i]);
      assert.ok(index >= 0 && current[index] > previous[index], 'New releases must advance latest, not roll it back');
    }
    return 'missing';
  }
  assert.equal(document.versions[pkg.version]?.dist?.integrity, integrity, 'Version exists with a different artifact; do not overwrite or bump automatically');
  return 'identical';
}

async function registryDocument(pkg) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(pkg.name)}`, { redirect: 'error', signal: AbortSignal.timeout(25_000) });
  assert.equal(response.status, 200, `Registry lookup failed (HTTP ${response.status}); first bootstrap must already exist`);
  return response.json();
}

async function main() {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  const filename = validateRelease(pkg, process.env);
  const output = async value => { if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${value}\n`); };
  const mode = process.argv[2];
  if (mode === 'preflight') { await output(`filename=${filename}`); console.log(`Release tag verified: ${pkg.name}@${pkg.version}`); return; }
  assert.ok(mode === 'registry' || mode === 'verify', 'Unknown release-check mode');
  const artifact = resolve(process.argv[3] ?? `release/${filename}`);
  assert.ok(artifact.endsWith(`/${filename}`) || artifact.endsWith(`\\${filename}`), 'Unexpected artifact path');
  const bytes = await readFile(artifact);
  const checksum = (await readFile(`${artifact}.sha256`, 'utf8')).trim().split(/\s+/);
  assert.deepEqual(checksum, [createHash('sha256').update(bytes).digest('hex'), filename], 'Artifact checksum mismatch');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  for (let attempt = 0; attempt < (mode === 'verify' ? 6 : 1); attempt++) {
    const document = await registryDocument(pkg);
    const state = publicationState(document, pkg, integrity);
    if (mode === 'registry') {
      await output(`publish=${state === 'missing'}`);
      console.log(state === 'missing' ? 'Version is unpublished; OIDC publish may proceed.' : 'Identical version is already published; publish is skipped.');
      return;
    }
    if (state === 'identical') {
      if (process.env.REQUIRE_PROVENANCE === 'true') assert.equal(typeof document.versions[pkg.version].dist?.attestations?.url, 'string', 'Published provenance is not reported');
      console.log(`Registry integrity verified: ${pkg.name}@${pkg.version}`);
      return;
    }
    if (attempt < 5) await new Promise(resolveWait => setTimeout(resolveWait, 5000));
  }
  throw new Error('Published version is not visible yet; investigate propagation before attempting another publish');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
