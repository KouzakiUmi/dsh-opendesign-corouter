import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRelease, publicationState } from '../scripts/release-check.mjs';

const pkg = { name: 'dsh-opendesign-corouter', version: '0.1.1', license: 'MIT' };
const env = { GITHUB_REPOSITORY: 'KouzakiUmi/dsh-opendesign-corouter', GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v0.1.1' };

test('release accepts exactly the stable package version tag', () => {
  assert.equal(validateRelease(pkg, env), 'dsh-opendesign-corouter-0.1.1.tgz');
});

test('branches, foreign repositories, mismatched tags and prereleases are denied', () => {
  for (const patch of [{ GITHUB_REF_TYPE: 'branch' }, { GITHUB_REPOSITORY: 'other/repository' }, { GITHUB_REF_NAME: 'v0.1.2' }]) assert.throws(() => validateRelease(pkg, { ...env, ...patch }));
  for (const version of ['0.1.1-beta.1', '01.1.1', '1.2', '1.2.3;echo unsafe']) assert.throws(() => validateRelease({ ...pkg, version }, { ...env, GITHUB_REF_NAME: `v${version}` }));
  assert.throws(() => validateRelease({ ...pkg, private: true }, env));
  assert.throws(() => validateRelease({ ...pkg, license: 'UNLICENSED' }, env));
});

test('unpublished versions require a valid existing package document', () => {
  assert.equal(publicationState({ name: pkg.name, versions: {} }, pkg, 'sha512-test'), 'missing');
  for (const value of [{ name: 'other', versions: {} }, { name: pkg.name }, { name: pkg.name, versions: [] }]) assert.throws(() => publicationState(value, pkg, 'sha512-test'));
});

test('a registry staging placeholder allows the first real release only', () => {
  const doc = { name: pkg.name, versions: { '0.0.0-stage': {} }, 'dist-tags': { latest: '0.0.0-stage' } };
  assert.equal(publicationState(doc, pkg, 'sha512-test'), 'missing');
  assert.throws(() => publicationState({ ...doc, versions: { ...doc.versions, '1.0.0': {} } }, pkg, 'sha512-test'));
});

test('new releases cannot roll back a newer latest version', () => {
  const doc = latest => ({ name: pkg.name, versions: {}, 'dist-tags': { latest } });
  assert.equal(publicationState(doc('0.1.0'), pkg, 'sha512-test'), 'missing');
  assert.throws(() => publicationState(doc('0.2.0'), pkg, 'sha512-test'));
  assert.throws(() => publicationState(doc('0.1.1'), pkg, 'sha512-test'));
  assert.throws(() => publicationState(doc('1.0.0-beta.1'), pkg, 'sha512-test'));
});

test('identical versions skip publish but mismatched or missing integrity fails', () => {
  const doc = integrity => ({ name: pkg.name, versions: { [pkg.version]: { dist: { integrity } } } });
  assert.equal(publicationState(doc('sha512-test'), pkg, 'sha512-test'), 'identical');
  assert.throws(() => publicationState(doc('sha512-other'), pkg, 'sha512-test'));
  assert.throws(() => publicationState(doc(undefined), pkg, 'sha512-test'));
});
