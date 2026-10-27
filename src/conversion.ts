// Adapted from dsh-opendesign-go message/image compatibility handling (MIT).
import { LlmError, offloadedImageText, textOnlyImageText, type ContentBlock, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';

export type ImageResolver = (ref: ImageAttachmentRef) => string | undefined;
type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Part[];
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  reasoning_content?: string;
}
function parts(blocks: readonly ContentBlock[], image?: ImageResolver): { text: string; images: string[] } {
  let text = '';
  const images: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text': text += block.text; break;
      case 'image': {
        const url = block.offloaded ? undefined : image?.(block.attachment);
        if (url) images.push(url);
        else text += `${text ? '\n' : ''}${block.offloaded ? offloadedImageText(block.attachment) : textOnlyImageText(block.attachment)}`;
        break;
      }
      case 'file': throw new LlmError('原始文件未被宿主投影为文本句柄', 'UNSUPPORTED_OPTION');
      // Tool definitions are already materialized in options.tools by Core.
      default: break;
    }
  }
  return { text, images };
}
function content(text: string, images: string[]): string | Part[] {
  return images.length ? [...(text ? [{ type: 'text' as const, text }] : []), ...images.map(url => ({ type: 'image_url' as const, image_url: { url } }))] : text;
}
export function chatMessages(options: GenerateOptions, image?: ImageResolver, replayReasoning = false): WireMessage[] {
  const out: WireMessage[] = [];
  let lifted: string[] = [];
  function flush() {
    if (!lifted.length) return;
    out.push({ role: 'user', content: content('(Image content from the preceding tool result.)', lifted) });
    lifted = [];
  }
  for (const message of options.messages) {
    if (message.role !== 'tool') flush();
    const parsed = parts(message.content, message.role === 'user' || message.role === 'tool' ? image : undefined);
    switch (message.role) {
      case 'system': case 'developer':
        if (parsed.text) out.push({ role: 'system', content: parsed.text });
        break;
      case 'user':
        if (parsed.text || parsed.images.length) out.push({ role: 'user', content: content(parsed.text, parsed.images) });
        break;
      case 'assistant': {
        const calls = message.content.filter(block => block.type === 'tool-call').map(block => ({ id: block.id, type: 'function' as const, function: { name: block.name, arguments: block.arguments } }));
        const reasoning = message.content.filter(block => block.type === 'reasoning').map(block => block.text).join('');
        if (parsed.text || calls.length || parsed.images.length) out.push({ role: 'assistant', content: content(parsed.text, parsed.images), ...(calls.length ? { tool_calls: calls } : {}), ...(replayReasoning && reasoning ? { reasoning_content: reasoning } : {}) });
        break;
      }
      case 'tool':
        out.push({ role: 'tool', tool_call_id: message.toolCallId, content: parsed.text || (parsed.images.length ? '(Image content follows in the next user message.)' : '') });
        lifted.push(...parsed.images);
        break;
    }
  }
  flush();
  if (options.system?.trim()) {
    const first = out[0];
    if (first?.role === 'system' && typeof first.content === 'string') first.content = `${options.system}\n\n${first.content}`;
    else out.unshift({ role: 'system', content: options.system });
  }
  return out;
}
export function chatTools(options: GenerateOptions) {
  return options.tools?.length ? options.tools.map(tool => ({ type: 'function' as const, function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined;
}
export function estimateTokens(value: unknown): number {
  let ascii = 0, wide = 0, images = 0;
  function walk(x: unknown): void {
    if (typeof x === 'string') { for (const c of x) { if ((c.codePointAt(0) ?? 0) < 128) ascii++; else wide++; } }
    else if (Array.isArray(x)) for (const item of x) walk(item);
    else if (x && typeof x === 'object') {
      if ('type' in x && x.type === 'image_url') { images++; return; }
      for (const item of Object.values(x)) walk(item);
    }
  }
  walk(value);
  return Math.ceil(ascii / 3.5 + wide / 2) + images * 1024;
}
