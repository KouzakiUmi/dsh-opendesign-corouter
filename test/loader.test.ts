// Real official Loader + TypertLoader composition of the built package.
//
// This spec deliberately avoids hand-registering anything: the package is
// mounted as a Loader entry by name, and the official typert-loader discovers
// its `./typert` export and registers the generated contribution itself. Only
// module arrival is substituted (the fixture Loader's `import`), because the
// vendored Loader's Node-internal importer is unavailable outside the shipped
// runtime; resolution still goes through standard ESM resolution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Context, type Fiber } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { validateTypertManifest } from '@deepseek-ai/dsh-typert-loader';
import * as typertLoader from '@deepseek-ai/dsh-typert-loader';
import { PLAN_PROVIDER, PAID_PROVIDER } from '../src/config.js';
import { REMOTE_PACKAGE, REMOTE_SERVICE } from '../src/remote.js';

/** Resolution anchor: the task root manifest, so package self-reference resolves this package. */
const ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url));
/** Profile entry id the shipped bundle patch uses; also the settings namespace. */
const ENTRY_ID = 'llm-opendesign-corouter';

const ENDPOINTS = [
  `${REMOTE_SERVICE}/status`,
  `${REMOTE_SERVICE}/refreshQuota`,
  `${REMOTE_SERVICE}/startLogin`,
  `${REMOTE_SERVICE}/loginStatus`,
  `${REMOTE_SERVICE}/cancelLogin`,
  `${REMOTE_SERVICE}/saveApiKey`,
] as const;

/** Loader whose module arrival uses standard ESM resolution from this package. */
class FixtureLoader extends Loader {
  override import(name: string) {
    return import(import.meta.resolve(name));
  }

  write(): void {}
}

/** Wait for derived state that the Loader stages across microtasks. */
async function eventually(loader: Loader, ready: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await loader.await();
    if (ready()) return;
    await new Promise(resolve => setTimeout(resolve, 4));
  }
  throw new Error('composition did not settle');
}

const entry = () => ({ id: ENTRY_ID, name: REMOTE_PACKAGE, config: {} });
const providerIds = (ctx: Context) => ctx.llm.listProviders().map(row => row.id).sort();

test('official Loader mounts the built package, typert-loader auto-registers its six RPC, and reload is conflict-free', async () => {
  const ctx = new Context();
  ctx.baseUrl = ANCHOR;
  const llm = await ctx.plugin(LlmRuntime);
  const registry = await ctx.plugin(TypertRegistry);
  const loaderFiber = await ctx.plugin(FixtureLoader, { baseUrl: ANCHOR });
  const loader = ctx.loader;
  let typertFiber: Fiber | undefined;
  try {
    // 1. The built package is a plain Loader entry: no manual registry call.
    await loader.root.update([entry()]);
    await eventually(loader, () => ctx.get(REMOTE_SERVICE) !== undefined);
    assert.deepEqual(providerIds(ctx), [PAID_PROVIDER, PLAN_PROVIDER]);
    assert.equal((await ctx.llm.listModels(PLAN_PROVIDER)).length, 12);
    assert.equal((await ctx.llm.listModels(PAID_PROVIDER)).length, 21);
    // Discovery alone registers nothing: that is typert-loader's job.
    assert.equal(ctx.typert.getPackage(REMOTE_PACKAGE, 'host'), undefined);

    // 2. Activate typert-loader once the entry exists; its activation pass covers it.
    typertFiber = await ctx.plugin(typertLoader);
    await eventually(loader, () => ctx.typert.getPackage(REMOTE_PACKAGE, 'host') !== undefined);

    const registered = ctx.typert.getPackage(REMOTE_PACKAGE, 'host');
    assert.ok(registered);
    assert.equal(registered.model.services.length, 0);
    assert.equal(ctx.typert.local.get(ENDPOINTS[0])?.service, REMOTE_SERVICE);
    for (const endpoint of ENDPOINTS) assert.ok(ctx.typert.local.get(endpoint) !== undefined, endpoint);
    assert.equal(ctx.typert.local.get(`${REMOTE_SERVICE}/status`)?.parameters.length, 0);
    assert.equal(ctx.typert.local.get(`${REMOTE_SERVICE}/startLogin`)?.parameters.length, 1);
    assert.equal(ctx.typert.local.get(`${REMOTE_SERVICE}/loginStatus`)?.result.mode, 'strict');

    // 3. The published artifact passes the official manifest boundary unchanged.
    const artifact = import.meta.resolve(`${REMOTE_PACKAGE}/typert`);
    const artifactTail = fileURLToPath(artifact).replaceAll('\\', '/').split('/').slice(-3).join('/');
    assert.equal(artifactTail, 'lib/generated/typert.host.js');
    const built = await import(artifact) as Record<string, unknown>;
    const contribution = validateTypertManifest(REMOTE_PACKAGE, built.TYPERT);
    assert.equal(contribution.package, REMOTE_PACKAGE);
    assert.equal(contribution.face, 'host');
    assert.deepEqual(contribution.invocations.map(row => row.id).sort(), ENDPOINTS.map(endpoint => `${REMOTE_PACKAGE}#${endpoint}`).sort());

    // 4. Unmounting the entry withdraws Providers and the Typert registration.
    loader.root.remove(ENTRY_ID);
    await eventually(loader, () => ctx.get(REMOTE_SERVICE) === undefined
      && ctx.typert.getPackage(REMOTE_PACKAGE, 'host') === undefined);
    assert.deepEqual(ctx.llm.listProviders(), []);

    // 5. A second mount reclaims the same names without a duplicate-registration conflict.
    await loader.root.update([entry()]);
    await eventually(loader, () => ctx.get(REMOTE_SERVICE) !== undefined
      && ctx.typert.getPackage(REMOTE_PACKAGE, 'host') !== undefined);
    assert.deepEqual(providerIds(ctx), [PAID_PROVIDER, PLAN_PROVIDER]);
    for (const endpoint of ENDPOINTS) assert.ok(ctx.typert.local.get(endpoint) !== undefined, endpoint);
  } finally {
    await typertFiber?.dispose();
    await loader.root.update([]);
    await loaderFiber.dispose();
    await registry.dispose();
    await llm.dispose();
  }
});
