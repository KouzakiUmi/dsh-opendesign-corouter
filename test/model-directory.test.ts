import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { ModelDirectory } from '../src/model-directory.js';
import type { CatalogModel } from '../src/catalog.js';
import type { ModelCatalogSnapshot } from '../src/model-catalog-snapshot.js';
import type { RuntimeConfig } from '../src/config.js';
import type { ModelAccount, ModelScope } from '../src/model-entitlements.js';
const account: ModelAccount = { source: 'device', session: { apiUrl: 'https://amr-api.open-design.ai', source: 'login', via: 'login', credentialType: 'device', headers: { authorization: 'Bearer fixture' } } };
const scope: ModelScope = { workspaceId: 'ws-fixture', memberId: 'member-fixture', source: 'device' };
const row: CatalogModel = { id: 'discovered-only', name: 'Discovered', group: 'paid' };
const config = (): RuntimeConfig => ({ baseURL: 'https://amr-link.open-design.ai/v1', useDesktopCredential: false, emptyTurnGuard: false, requestTimeoutMs: 1000, streamIdleTimeoutMs: 1000 });
const until = async (check: () => boolean) => { for (let i=0;i<100;i++) { if(check()) return; await tick(); } assert.fail('fixture did not settle'); };

test('automatic refresh is shared, uses one verified scope, and expires after ten minutes', async () => {
  let calls = 0, scopeReads = 0;
  const saved: ModelCatalogSnapshot[] = [];
  const directory = new ModelDirectory({ config, state: async () => ({ key: 'runtime-fixture', account }), bindingSecret: async () => new Uint8Array(32).fill(1),
    changed: () => {}, persist: async snapshot => { saved.push(snapshot); return 'saved'; },
    readScope: async () => { scopeReads++; return scope; },
    fetchModels: async (_base, _key, _signal, _fetcher, workspace) => { calls++; assert.equal(workspace, scope.workspaceId); return [row]; },
    readEntitlements: async models => ({ models: models.map(model => ({ ...model, coverage: 'included', group: 'plan' })), summary: { state: 'verified', source: 'device' } }),
  });
  const now = Date.now; let clock = now(); Date.now = () => clock;
  try {
    directory.warm(); directory.warm(); await until(() => saved.length===1);
    assert.equal(calls,1); assert.equal(scopeReads,2); assert.equal(directory.workspace(),scope.workspaceId);
    assert.equal(directory.models()[0]?.coverage,'included');
    directory.warm(); await tick(); assert.equal(calls,1);
    clock += 10*60_000; directory.warm(); await until(()=>calls===2);
  } finally { Date.now=now; directory.dispose(); }
});

test('a workspace switch during preflights never publishes the previous scope as current', async () => {
  let reads=0, writes=0;
  const directory = new ModelDirectory({ config, state: async()=>({key:'runtime-fixture',account}), bindingSecret:async()=>new Uint8Array(32).fill(1),changed:()=>{},persist:async()=>{writes++;return 'saved';},
    readScope:async()=>++reads===1?scope:{...scope,workspaceId:'other'},fetchModels:async()=>[row],
    readEntitlements:async()=>({models:[{...row,group:'plan',coverage:'included'}],summary:{state:'verified'}}),
  });
  try { await directory.refresh(); assert.equal(writes,0);assert.ok(directory.models().every(model=>model.coverage==='unknown'));assert.ok(directory.error()); }
  finally { directory.dispose(); }
});

test('saved snapshots restore only after a keyed runtime/gateway/scope match and revalidate coverage', async () => {
  const current=config(); let snapshot:ModelCatalogSnapshot|undefined;
  const options={config:()=>current,state:async()=>({key:'runtime-fixture',account}),bindingSecret:async()=>new Uint8Array(32).fill(2),changed:()=>{},persist:async(value:ModelCatalogSnapshot)=>{snapshot=value;return 'saved' as const;},readScope:async()=>scope};
  const first=new ModelDirectory({...options,fetchModels:async()=>[row],readEntitlements:async()=>({models:[{...row,group:'plan',coverage:'included'}],summary:{state:'verified'}})});
  await first.refresh();await until(()=>snapshot!==undefined);first.dispose();current.modelCatalog=snapshot!;
  for(const [key,expected] of [['runtime-fixture',true],['different-key',false]] as const){
    const restarted=new ModelDirectory({...options,state:async()=>({key,account}),fetchModels:async()=>{throw new Error('offline');}});
    try { assert.equal(restarted.models().some(model=>model.id===row.id),false);await restarted.refresh();assert.equal(restarted.models().some(model=>model.id===row.id),expected);assert.ok(restarted.models().every(model=>model.coverage==='unknown'));if(expected)assert.equal(restarted.callIdentity()?.workspace,scope.workspaceId); }
    finally {restarted.dispose();}
  }
});

test('observed workspace drift clears old coverage and blocks calls when replacement discovery fails',async()=>{
 let selected=scope,fail=false;
 const directory=new ModelDirectory({config,state:async()=>({key:'fixture-key',account}),bindingSecret:async()=>new Uint8Array(32),changed:()=>{},persist:async()=> 'saved',readScope:async()=>selected,
 fetchModels:async()=>{if(fail)throw new Error('offline');return[row];},readEntitlements:async()=>({models:[{...row,group:'plan',coverage:'included'}],summary:{state:'verified'}})});
 try{await directory.refresh();assert.equal(directory.workspace(),scope.workspaceId);selected={...scope,workspaceId:'new-workspace'};fail=true;await directory.refresh();assert.equal(directory.workspace(),undefined);assert.equal(directory.entitlements().state,'unavailable');assert.ok(directory.models().every(model=>model.coverage==='unknown'));assert.throws(()=>directory.callIdentity());}
 finally{directory.dispose();}
});

test('an unchanged bound catalog does not rewrite settings on every refresh/reload',async()=>{
 const current=config();let writes=0;
 const directory=new ModelDirectory({config:()=>current,state:async()=>({key:'fixture-key'}),bindingSecret:async()=>new Uint8Array(32),changed:()=>{},persist:async snapshot=>{writes++;current.modelCatalog=snapshot;return 'saved';},fetchModels:async()=>[row]});
 try{await directory.refresh();await until(()=>writes===1);await directory.refresh();await tick();assert.equal(writes,1);}
 finally{directory.dispose();}
});

test('an identity invalidation cancels stale discovery and cannot publish a late result', async () => {
  let key='one', release!:()=>void, called=false;
  const gate=new Promise<void>(done=>{release=done;});
  const directory=new ModelDirectory({config,state:async()=>({key}),bindingSecret:async()=>new Uint8Array(32),changed:()=>{},persist:async()=> 'saved',fetchModels:async()=>{called=true;await gate;return[row];}});
  try {const pending=directory.refresh();await until(()=>called);key='two';directory.invalidate();release();await pending;assert.equal(directory.models().some(model=>model.id===row.id),false);}
  finally{directory.dispose();}
});

test('a saved, identity-bound directory is republished without one preflight per model', async () => {
  const current = config();
  let snapshots = 0;
  const shared = {
    config: () => current,
    state: async () => ({ key: 'runtime-fixture', account }),
    bindingSecret: async () => new Uint8Array(32).fill(3),
    readScope: async () => scope,
    persist: async (value: ModelCatalogSnapshot) => { snapshots++; current.modelCatalog = value; return 'saved' as const; },
  };
  const first = new ModelDirectory({ ...shared, changed: () => {}, fetchModels: async () => [row],
    readEntitlements: async models => ({ models: models.map(model => ({ ...model, group: 'plan' as const, coverage: 'included' as const })), summary: { state: 'verified' } }) });
  await first.refresh();
  await until(() => snapshots === 1);
  first.dispose();

  // A settings write reloads this plugin: the restarted instance answers from the saved copy.
  let fetches = 0, changed = 0;
  const restarted = new ModelDirectory({ ...shared, changed: () => { changed++; }, fetchModels: async () => { fetches++; return [row]; } });
  try {
    restarted.warm();
    await until(() => restarted.updatedAt() !== undefined);
    assert.equal(fetches, 0, 'a fresh saved directory is not crawled again');
    assert.equal(changed, 1, 'the model selector is updated once');
    assert.equal(restarted.models().some(model => model.id === row.id), true);
    assert.equal(restarted.models()[0]?.coverage, 'unknown', 'saved coverage is never claimed before a preflight');
    assert.equal(restarted.callIdentity()?.workspace, scope.workspaceId, 'the surviving snapshot stays scoped');
    restarted.warm();
    await tick();
    assert.equal(fetches, 0, 'the refresh window keeps the saved copy in place');
  } finally { restarted.dispose(); }
});

test('an old saved directory is published first and then refreshed in the background', async () => {
  const current = config();
  let fetches = 0, changed = 0;
  const options = {
    config: () => current,
    state: async () => ({ key: 'runtime-fixture', account }),
    bindingSecret: async () => new Uint8Array(32).fill(4),
    readScope: async () => scope,
    persist: async () => 'saved' as const,
  };
  const seed = new ModelDirectory({ ...options, changed: () => {}, fetchModels: async () => [row], readEntitlements: async models => ({ models, summary: { state: 'verified' } }) });
  let snapshot: ModelCatalogSnapshot | undefined;
  const capture = new ModelDirectory({ ...options, changed: () => {}, fetchModels: async () => [row], persist: async value => { snapshot = value; return 'saved'; } });
  await capture.refresh();
  await until(() => snapshot !== undefined);
  current.modelCatalog = { ...snapshot!, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() };
  seed.dispose(); capture.dispose();
  const restarted = new ModelDirectory({ ...options, changed: () => { changed++; }, fetchModels: async () => { fetches++; return [row]; } });
  try {
    restarted.warm();
    await until(() => restarted.updatedAt() !== undefined);
    assert.equal(restarted.models()[0]?.coverage, 'unknown', 'the saved copy answers at once');
    await until(() => fetches === 1);
    assert.ok(changed >= 1);
  } finally { restarted.dispose(); }
});

test('a stale bound snapshot answers ensurePublished at once while the full read runs in the background', async () => {
  const current = config();
  let snapshot: ModelCatalogSnapshot | undefined;
  const verified = async (models: readonly CatalogModel[]) => ({ models: models.map(model => ({ ...model, group: 'plan' as const, coverage: 'included' as const })), summary: { state: 'verified' as const } });
  const shared = {
    config: () => current,
    state: async () => ({ key: 'runtime-fixture', account }),
    bindingSecret: async () => new Uint8Array(32).fill(5),
    readScope: async () => scope,
    persist: async (value: ModelCatalogSnapshot) => { snapshot = value; return 'saved' as const; },
    readEntitlements: verified,
  };
  const first = new ModelDirectory({ ...shared, changed: () => {}, fetchModels: async () => [row] });
  await first.refresh();
  await until(() => snapshot !== undefined);
  first.dispose();
  current.modelCatalog = { ...snapshot!, updatedAt: new Date(Date.now() - 11 * 60_000).toISOString() };

  let release!: () => void;
  const gate = new Promise<void>(done => { release = done; });
  let fetches = 0;
  const restarted = new ModelDirectory({ ...shared, changed: () => {}, fetchModels: async () => { fetches++; await gate; return [row]; } });
  try {
    // The model picker's wait path must settle without the gated gateway read.
    await restarted.ensurePublished();
    assert.equal(restarted.models().some(model => model.id === row.id), true, 'the stale bound snapshot answers selection at once');
    assert.equal(restarted.models()[0]?.coverage, 'unknown', 'saved coverage is never claimed before a preflight');
    // ensurePublished already returned while the gate is held; the read now runs in background.
    await until(() => fetches === 1);
    release();
    await until(() => restarted.models()[0]?.coverage === 'included');
    assert.equal(restarted.error(), undefined);
  } finally { release(); restarted.dispose(); }
});
