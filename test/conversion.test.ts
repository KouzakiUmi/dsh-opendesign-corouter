import test from 'node:test';
import assert from 'node:assert/strict';
import { createMessage, createAssistantMessage, createSystemMessage, ToolCallId, type GenerateOptions } from '@deepseek-ai/dsh-llm';
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment';
import { chatMessages } from '../src/conversion.js';
const image: ImageAttachmentRef = { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 100, width: 10, height: 10, name: 'fixture.png' };
const imageUrl = 'data:image/png;base64,fixture';
const base: GenerateOptions = { provider: 'fixture', model: 'fixture', messages: [] };
test('system text, assistant calls and reasoning replay are projected without mutation', () => {
  const assistant = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'reasoning', text: 'private reasoning trace fixture' }, { type: 'tool-call', id: ToolCallId('call'), name: 'read', arguments: '{}' }] });
  const messages = chatMessages({ ...base, system: 'prepend', messages: [createSystemMessage('system'), assistant] }, undefined, true);
  assert.equal(messages[0]?.content, 'prepend\n\nsystem');
  assert.equal(messages[1]?.reasoning_content, 'private reasoning trace fixture');
  assert.equal(messages[1]?.tool_calls?.[0]?.function.name, 'read');
  assert.equal(assistant.content.length, 2);
});
test('tool images are hoisted after the consecutive tool group with nonempty placeholder text', () => {
  const make = (id: string) => createMessage({ role: 'tool', source: { kind: 'tool', callId: ToolCallId(id) }, toolCallId: ToolCallId(id), content: [{ type: 'image', attachment: image }] });
  const wire = chatMessages({ ...base, messages: [make('a'), make('b')] }, () => imageUrl);
  assert.deepEqual(wire.map(x => x.role), ['tool', 'tool', 'user']);
  assert.ok(typeof wire[0]?.content === 'string' && wire[0].content.length > 0);
  assert.equal(Array.isArray(wire[2]?.content) && wire[2].content.filter(x => x.type === 'image_url').length, 2);
});
test('historical assistant images and offloaded user images never become unsupported image parts', () => {
  const assistant = createAssistantMessage({ source: { provider: 'fixture', model: 'fixture' }, content: [{ type: 'image', attachment: image }] });
  const wire = chatMessages({ ...base, messages: [assistant, { role: 'user', content: [{ type: 'image', attachment: image, offloaded: true }] }] }, () => imageUrl);
  assert.ok(wire.every(x => typeof x.content === 'string' && !x.content.includes(imageUrl)));
});
