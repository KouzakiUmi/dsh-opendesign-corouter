import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssistantMessage, createMessage, ToolCallId, type StreamChunk } from '@deepseek-ai/dsh-llm';
import { buildResponsesRequest, streamResponses } from '../src/protocols/responses.js';
import type { ProtocolContext } from '../src/protocols/types.js';
const model = { id: 'gpt-6.1-sol', name: 'Sol', group: 'paid' as const };
const identity = { provider:'fixture', model:model.id, baseURL:'https://gateway.invalid/v1', credentialIdentity:'fixture-hmac' };
const call={type:'function_call',id:'fc_1',call_id:'call_1',name:'read',arguments:'{}'};
const output=[{type:'reasoning',id:'rs_1',summary:[{type:'summary_text',text:'summary'}],encrypted_content:'opaque-ciphertext'},call];
const source=()=>new Response(`data: ${JSON.stringify({type:'response.completed',response:{output}})}\n\n`).body!;
const context=(messages:ProtocolContext['options']['messages']):ProtocolContext=>({baseURL:identity.baseURL,apiKey:'fixture-key',model,credentialIdentity:identity.credentialIdentity,images:new Map(),options:{provider:identity.provider,model:model.id,messages}});

test('store:false Responses preserve encrypted reasoning and tool items on the same unmodified route',async()=>{
 const chunks:StreamChunk[]=[];for await(const chunk of streamResponses(source(),new AbortController().signal,1000,identity))chunks.push(chunk);
 const end=chunks.find(chunk=>chunk.type==='finish');assert.equal(end?.type,'finish');if(end?.type!=='finish')return;
 assert.ok(end.replayState);
 assert.equal(chunks.filter(chunk=>chunk.type==='reasoning-delta').map(chunk=>chunk.text).join(''),'summary');
 assert.ok(!JSON.stringify(chunks.filter(chunk=>chunk.type!=='finish')).includes('opaque-ciphertext'));
 const blocks=chunks.filter((chunk):chunk is Extract<StreamChunk,{type:'block-end'}>=>chunk.type==='block-end').map(chunk=>chunk.block);
 const assistant=createAssistantMessage({source:{provider:identity.provider,model:model.id,replayState:end.replayState},content:blocks});
 const messages:ProtocolContext['options']['messages']=[{role:'user',content:[{type:'text',text:'hi'}]},assistant,createMessage({role:'tool',source:{kind:'tool',callId:ToolCallId('call_1')},toolCallId:ToolCallId('call_1'),content:[{type:'text',text:'ok'}]})];
 const request=buildResponsesRequest(context(messages));const body=request.body as {input:Record<string,unknown>[];store:boolean;include:string[]};
 assert.equal(body.store,false);assert.deepEqual(body.include,['reasoning.encrypted_content']);
 assert.deepEqual(body.input.slice(1,3),output);
 const changed={...context(messages),credentialIdentity:'another-identity'};
 assert.ok(!(buildResponsesRequest(changed).body as {input:Record<string,unknown>[]}).input.some(item=>item.encrypted_content));
 const edited=createAssistantMessage({source:{provider:identity.provider,model:model.id,replayState:end.replayState},content:[{type:'text',text:'edited'},...blocks]});
 assert.ok(!(buildResponsesRequest(context([messages[0]!,edited])).body as {input:Record<string,unknown>[]}).input.some(item=>item.encrypted_content));
});

test('nullable or missing encrypted reasoning never erases valid commentary phase and tool items',async()=>{
 for(const encryption of [undefined,null]){
  const projected=[{type:'reasoning',id:'rs_2',summary:[{type:'summary_text',text:'summary'}],...(encryption===undefined?{}:{encrypted_content:encryption})},
   {type:'message',id:'msg_1',role:'assistant',phase:'commentary',content:[{type:'output_text',text:'Checking',annotations:[]}]},call];
  const body=new Response(`data: ${JSON.stringify({type:'response.completed',response:{output:projected}})}\n\n`).body!;
  const chunks:StreamChunk[]=[];for await(const chunk of streamResponses(body,new AbortController().signal,1000,identity))chunks.push(chunk);
  const end=chunks.find(chunk=>chunk.type==='finish');assert.ok(end?.type==='finish'&&end.replayState);if(end?.type!=='finish'||!end.replayState)continue;
  const blocks=chunks.filter((chunk):chunk is Extract<StreamChunk,{type:'block-end'}>=>chunk.type==='block-end').map(chunk=>chunk.block);
  const assistant=createAssistantMessage({source:{provider:identity.provider,model:model.id,replayState:end.replayState},content:blocks});
  const wire=buildResponsesRequest(context([assistant])).body as {input:Record<string,unknown>[]};
  assert.equal(wire.input[0]?.phase,'commentary');assert.equal(wire.input[1]?.type,'function_call');assert.equal(wire.input.length,2);
 }
});
