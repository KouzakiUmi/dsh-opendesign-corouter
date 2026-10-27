import { randomBytes } from 'node:crypto';
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { record } from './util.js';

export const REPLAY_BINDING_KEY = credentialKey('llm-opendesign-corouter', 'claude-replay-binding');
type ReplayCredentials = Pick<CredentialProvider, 'readRecord' | 'modifyRecord'>;
const unavailable = () => new LlmError('无法读取或安全保存 Claude 回放绑定密钥。请检查 DSH 凭据服务及该插件的回放绑定记录；原有记录未被替换。', 'INVALID_REQUEST');
const cancelled = () => new LlmError('Claude 回放绑定已取消', 'ABORTED');

function decode(value: CredentialRecord | undefined): Buffer | undefined {
  if (value?.kind !== 'grant' || !record(value.payload)) return;
  const payload = value.payload;
  if (payload.format !== 'opendesign-claude-replay-key' || payload.version !== 1
    || typeof payload.secret !== 'string' || !/^[A-Za-z0-9+/]{43}=$/u.test(payload.secret)
    || Object.keys(payload).some(key => !['format', 'version', 'secret'].includes(key))) return;
  const secret = Buffer.from(payload.secret, 'base64');
  if (secret.length !== 32 || secret.toString('base64') !== payload.secret) { secret.fill(0); return; }
  return secret;
}

/** Lazy, atomic credential-service binding. No inference key ever enters this store. */
export class ReplayKeyStore {
  readonly #lifetime = new AbortController();
  #fallback: Buffer | undefined;
  constructor(readonly provider: () => ReplayCredentials | undefined) {}
  dispose(): void {
    this.#lifetime.abort();
    this.#fallback?.fill(0);
    this.#fallback = undefined;
  }
  /** Returns caller-owned bytes; callers clear them after deriving the binding. */
  async get(signal: AbortSignal): Promise<Uint8Array> {
    const lifetime = AbortSignal.any([signal, this.#lifetime.signal]);
    if (lifetime.aborted) throw cancelled();
    let abort: () => void = () => {};
    try {
      const provider = this.provider();
      if (!provider) {
        this.#fallback ??= randomBytes(32);
        return Buffer.from(this.#fallback);
      }
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(cancelled());
        lifetime.addEventListener('abort', abort, { once: true });
        if (lifetime.aborted) abort();
      });
      const current = await Promise.race([provider.readRecord(REPLAY_BINDING_KEY), aborted]);
      if (lifetime.aborted) throw cancelled();
      if (current !== undefined) {
        const secret = decode(current);
        if (!secret) throw unavailable();
        return secret;
      }
      const operation = provider.modifyRecord(REPLAY_BINDING_KEY, async current => {
        if (lifetime.aborted) throw cancelled();
        if (current !== undefined) {
          const existing = decode(current);
          if (!existing) throw unavailable();
          existing.fill(0);
          return undefined;
        }
        const bytes = randomBytes(32);
        const secret = bytes.toString('base64'); bytes.fill(0);
        return { kind: 'grant', payload: { format: 'opendesign-claude-replay-key', version: 1, secret } };
      });
      const value = await Promise.race([operation, aborted]);
      if (lifetime.aborted) throw cancelled();
      const secret = decode(value);
      if (!secret) throw unavailable();
      return secret;
    } catch {
      throw lifetime.aborted ? cancelled() : unavailable();
    } finally { lifetime.removeEventListener('abort', abort); }
  }
}
