/**
 * usage 归一化：把上游计数折算成 DSH 的**不相交**口径。
 *
 * `TokenUsage.inputTokens` 只计未缓存输入；缓存读取/写入单独上报，三者相加才是计费输入。
 * 两套上游口径不同，必须分开处理：
 * - OpenAI（Chat / Responses）的输入总数**包含**缓存命中，需要减出来；
 * - Anthropic Messages 的 `input_tokens` **不含**缓存读取与缓存写入，直接对应。
 *
 * 任何非法或自相矛盾的缓存计数都会被丢弃，而不是产生负数或凭空的输入量。
 */

import type { TokenUsage } from '@deepseek-ai/dsh-llm';

/** 上游原始计数（缺省或非法一律视为未知）。 */
export interface RawUsage {
  input?: number | undefined;
  output?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  reasoning?: number | undefined;
  total?: number | undefined;
}

function valid(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0;
}

/**
 * OpenAI 口径：`input` 含缓存命中。
 *
 * @param raw 上游计数。
 * @returns 归一化 usage；输入或输出缺失、为负时返回 undefined。
 */
export function openAiUsage(raw: RawUsage): TokenUsage | undefined {
  const input = raw.input, output = raw.output;
  if (!valid(input) || !valid(output)) return undefined;
  const read = valid(raw.cacheRead) ? raw.cacheRead : 0;
  const write = valid(raw.cacheWrite) ? raw.cacheWrite : 0;
  const cached = read + write <= input;
  const reasoning = valid(raw.reasoning) && raw.reasoning <= output ? raw.reasoning : undefined;
  return {
    inputTokens: cached ? input - read - write : input,
    outputTokens: output,
    totalTokens: input + output,
    ...(cached && read > 0 ? { cacheReadTokens: read } : {}),
    ...(cached && write > 0 ? { cacheWriteTokens: write } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}

/**
 * Anthropic 口径：`input` 不含缓存，缓存读取/写入是独立计数。
 *
 * @param raw 上游计数。
 * @returns 归一化 usage；输入或输出缺失、为负时返回 undefined。
 */
export function anthropicUsage(raw: RawUsage): TokenUsage | undefined {
  const input = raw.input, output = raw.output;
  if (!valid(input) || !valid(output)) return undefined;
  const read = valid(raw.cacheRead) ? raw.cacheRead : undefined;
  const write = valid(raw.cacheWrite) ? raw.cacheWrite : undefined;
  const reasoning = valid(raw.reasoning) && raw.reasoning <= output ? raw.reasoning : undefined;
  const total = valid(raw.total) ? raw.total : input + (read ?? 0) + (write ?? 0) + output;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(read !== undefined && read > 0 ? { cacheReadTokens: read } : {}),
    ...(write !== undefined && write > 0 ? { cacheWriteTokens: write } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
}
