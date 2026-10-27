import { LlmError } from '@deepseek-ai/dsh-llm';
import { claudeOutputError, claudeSamplingError } from './claude-capabilities.js';

/** Reject unsupported explicit overrides rather than silently changing their meaning. */
export function validateClaudeSampling(model: string, temperature: number | undefined, topP: number | undefined): void {
  const error = claudeSamplingError(model, 'messages', temperature, topP);
  if (error !== undefined) throw new LlmError(error, 'UNSUPPORTED_OPTION');
}

export function validateClaudeOutput(model: string, maxTokens: number | undefined): void {
  const error = claudeOutputError(model, 'messages', maxTokens);
  if (error !== undefined) throw new LlmError(error, 'UNSUPPORTED_OPTION');
}
