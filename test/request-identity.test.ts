import test from 'node:test';
import assert from 'node:assert/strict';
import { CoRouterAdapter } from '../src/adapter.js';
import { PAID_PROVIDER, type RuntimeConfig } from '../src/config.js';
import type { StreamChunk } from '@deepseek-ai/dsh-llm';
const config:RuntimeConfig={baseURL:'https://gateway.invalid/v1',apiProtocol:'chat-completions',useDesktopCredential:false,emptyTurnGuard:false,requestTimeoutMs:1000,streamIdleTimeoutMs:1000};
const rows=[{id:'fixture-model',name:'Fixture',group:'paid' as const}];
const options={provider:PAID_PROVIDER,model:rows[0]!.id,messages:[{role:'user' as const,content:[{type:'text' as const,text:'hi'}]}]};
const collect=async(stream:AsyncIterable<StreamChunk>)=>{for await(const _ of stream){/* fully consume */}};
const response=()=>new Response(`data: ${JSON.stringify({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);

test('prepared requests keep their runtime key and workspace together across account changes',async()=>{
 let identity:{key:string;workspace:string}={key:'account-a-key',workspace:'workspace-a'};
 let ambient='account-a-key';const sent:Headers[]=[];
 const adapter=new CoRouterAdapter({config:()=>config,models:()=>rows,apiKey:async()=>ambient,callIdentity:()=>identity,fetch:async(_url,init)=>{sent.push(new Headers(init?.headers));return response();}});
 try{const prepared=await adapter.prepareCall(PAID_PROVIDER,rows[0]!.id);identity={key:'account-b-key',workspace:'workspace-b'};ambient='account-b-key';await collect(prepared.stream(options));
 assert.equal(sent[0]?.get('authorization'),'Bearer account-a-key');assert.equal(sent[0]?.get('x-vela-workspace-id'),'workspace-a');
 await collect(adapter.stream(options));assert.equal(sent[1]?.get('authorization'),'Bearer account-b-key');assert.equal(sent[1]?.get('x-vela-workspace-id'),'workspace-b');}
 finally{adapter.dispose();}
});

test('cancelled model preparation stops waiting without aborting shared directory refresh',async()=>{
 let release!:()=>void;let resolved=false;const gate=new Promise<readonly typeof rows[number][]>(done=>{release=()=>{resolved=true;done(rows);};});
 const adapter=new CoRouterAdapter({config:()=>config,models:()=>rows,readyModels:()=>gate,apiKey:async()=> 'fixture'});
 const controller=new AbortController();try{const prepared=adapter.prepareCall(PAID_PROVIDER,rows[0]!.id,controller.signal);controller.abort();await assert.rejects(prepared,{code:'ABORTED'});assert.equal(resolved,false);release();await Promise.resolve();}
 finally{release();adapter.dispose();}
});

test('directory-owned requests fail closed instead of using unscoped ambient keys',async()=>{
 let keyReads=0,calls=0;
 const adapter=new CoRouterAdapter({config:()=>config,models:()=>rows,readyModels:async()=>rows,callIdentity:()=>undefined,apiKey:async()=>{keyReads++;return 'ambient-key';},fetch:async()=>{calls++;return response();}});
 try{await assert.rejects(adapter.prepareCall(PAID_PROVIDER,rows[0]!.id),{code:'INVALID_REQUEST'});assert.throws(()=>adapter.stream(options),{code:'INVALID_REQUEST'});assert.equal(keyReads,0);assert.equal(calls,0);}
 finally{adapter.dispose();}
});

test('saved incompatible defaults fail preparation before reading fallback credentials',async()=>{
 let reads=0;
 const adapter=new CoRouterAdapter({config:()=>({...config,apiProtocol:'messages',modelSettings:{'claude-fable-5.2':{reasoningEffort:'none'}}}),models:()=>[{id:'claude-fable-5.2',name:'Fable',group:'paid',reasoningEfforts:['high'],defaultEffort:'high'}],apiKey:async()=>{reads++;return 'fixture';}});
 try{await assert.rejects(adapter.prepareCall(PAID_PROVIDER,'claude-fable-5.2'),{code:'UNSUPPORTED_OPTION'});assert.equal(reads,0);}
 finally{adapter.dispose();}
});
