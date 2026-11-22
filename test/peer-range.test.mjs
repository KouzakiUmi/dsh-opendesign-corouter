import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const peers = Object.entries(pkg.peerDependencies).filter(([name]) => name.startsWith('@deepseek-ai/dsh-'));
// node-semver 只放行「范围里某个比较符与该版本元组一致且自带预发布标签」的预发布版本，
// 所以每个已出现的 0.2.x minor 都要有自己的带预发布下界分支。
const RANGE = '>=0.2.1-rc.3 <0.2.2-0 || >=0.2.2-0 <0.3.0-0';

test('every Core peer range and engines.dsh carry the per-minor prerelease branches', () => {
  assert.ok(peers.length >= 8, 'Core peer packages are declared');
  for (const [name, range] of peers) assert.equal(range, RANGE, name);
  assert.equal(pkg.engines.dsh, RANGE);
});

test('semver accepts the prerelease Cores the branches name and excludes the rest', () => {
  for (const version of ['0.2.1-rc.3', '0.2.1-rc.9', '0.2.1', '0.2.2-rc.5', '0.2.2']) {
    assert.ok(semver.satisfies(version, RANGE), `should accept ${version}`);
  }
  for (const version of ['0.2.1-rc.2', '0.2.0', '0.3.0-rc.1', '0.3.0']) {
    assert.ok(!semver.satisfies(version, RANGE), `should exclude ${version}`);
  }
  // 0.2.3 的预发布需要自己的分支：Core 升 minor 时补 RANGE、本清单与 README 兼容表。
  assert.ok(!semver.satisfies('0.2.3-rc.1', RANGE), 'a future minor prerelease stays excluded until its branch exists');
});
