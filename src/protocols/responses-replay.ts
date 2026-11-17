/** Bounded opaque Responses replay for store:false tool continuations. */
import { createHash } from 'node:crypto';
import type { ContentBlock, RequestMessage, StreamChunk, ReplayEnvelope } from '@deepseek-ai/dsh-llm';
import { record } from '../util.js';
import type { ProtocolContext, ProtocolStreamContext } from './types.js';
const FORMAT = 'opendesign.responses';
const MAX_CHARS = 8 * 1024 * 1024;
const MAX_ITEMS = 4096;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Rebuild documented input/output item shapes; arbitrary fields never reach a request. */
function outputItems(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) return;
  const serialized = JSON.stringify(value);
  if (serialized.length > MAX_CHARS) return;
  const out: Record<string, unknown>[] = [];
  for (const item of value) {
    if (!record(item) || typeof item.id !== 'string' || item.id.length > 512) return;
    if (item.type === 'reasoning') {
      if (item.encrypted_content !== undefined && item.encrypted_content !== null && typeof item.encrypted_content !== 'string') return;
      if (!Array.isArray(item.summary)) return;
      const summary: { type: string; text: string }[] = [];
      for (const entry of item.summary) {
        if (!record(entry) || entry.type !== 'summary_text' || typeof entry.text !== 'string') return;
        summary.push({ type: 'summary_text', text: entry.text });
      }
      const content: { type: 'reasoning_text'; text: string }[] = [];
      if (item.content !== undefined) {
        if (!Array.isArray(item.content)) return;
        for (const part of item.content) {
          if (!record(part) || part.type !== 'reasoning_text' || typeof part.text !== 'string') return;
          content.push({ type: 'reasoning_text', text: part.text });
        }
      }
      // Summary-only reasoning cannot resume private state, but must not erase unrelated phase.
      if (typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0) out.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary, ...(item.content === undefined ? {} : { content }) });
    } else if (item.type === 'message') {
      if (item.role !== 'assistant' || !Array.isArray(item.content)) return;
      const content: Record<string, unknown>[] = [];
      for (const part of item.content) {
        if (!record(part)) return;
        if (part.type === 'output_text' && typeof part.text === 'string') content.push({ type: 'output_text', text: part.text, annotations: [] });
        else if (part.type === 'refusal' && typeof part.refusal === 'string') content.push({ type: 'refusal', refusal: part.refusal });
        else return;
      }
      if (item.phase !== undefined && !['commentary', 'final_answer'].includes(String(item.phase))) return;
      out.push({ type: 'message', id: item.id, role: 'assistant', content, ...(item.phase ? { phase: item.phase } : {}) });
    } else if (item.type === 'function_call') {
      if (typeof item.call_id !== 'string' || typeof item.name !== 'string' || typeof item.arguments !== 'string') return;
      out.push({ type: 'function_call', id: item.id, call_id: item.call_id, name: item.name, arguments: item.arguments });
    } else return;
  }
  return out;
}
function visibleMatches(items: readonly Record<string, unknown>[], blocks: readonly ContentBlock[]): boolean {
  const text = items.filter(item => item.type === 'message').flatMap(item => item.content as Record<string, unknown>[]).map(part => part.text ?? part.refusal ?? '').join('');
  if (text !== blocks.filter(block => block.type === 'text').map(block => block.text).join('')) return false;
  const calls = items.filter(item => item.type === 'function_call').map(item => [item.call_id, item.name, item.arguments]);
  const actual = blocks.filter(block => block.type === 'tool-call').map(block => [block.id, block.name, block.arguments]);
  return JSON.stringify(calls) === JSON.stringify(actual);
}

/** Only an unmodified assistant message from the same exact route and credential can replay. */
export function responseReplay(message: RequestMessage, ctx: ProtocolContext): readonly Record<string, unknown>[] | undefined {
  if (message.role !== 'assistant' || message.source.provider !== ctx.options.provider || message.source.model !== ctx.model.id) return;
  const state = message.source.replayState;
  if (!record(state) || !record(state.response) || !Array.isArray(state.blocks) || state.blocks.length !== message.content.length) return;
  const response = state.response;
  if (response.format !== FORMAT || response.version !== 1 || response.provider !== ctx.options.provider || response.model !== ctx.model.id
    || response.baseURL !== ctx.baseURL || !ctx.credentialIdentity || response.credentialIdentity !== ctx.credentialIdentity
    || response.blocksDigest !== digest(message.content) || JSON.stringify(state.blocks) !== JSON.stringify(message.content)) return;
  const items = outputItems(response.output);
  return items && visibleMatches(items, message.content) ? items : undefined;
}

/** Opaque encrypted items stay in replayState, never in visible reasoning text. */
export function responseReplayEnvelope(output: unknown, closed: readonly StreamChunk[], context?: ProtocolStreamContext): ReplayEnvelope | undefined {
  if (!context?.credentialIdentity) return;
  const items = outputItems(output);
  if (!items?.length || !items.some(item => item.type === 'reasoning' || item.phase !== undefined)) return;
  const blocks = closed.filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> => chunk.type === 'block-end').map(chunk => chunk.block);
  if (blocks.length > MAX_ITEMS || JSON.stringify(blocks).length > MAX_CHARS || !visibleMatches(items, blocks)) return;
  return { response: {
    format: FORMAT, version: 1, provider: context.provider, model: context.model, baseURL: context.baseURL,
    credentialIdentity: context.credentialIdentity, blocksDigest: digest(blocks), output: items,
  }, blocks };
}
