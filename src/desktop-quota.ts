import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { AuthSession } from './auth.js';
import { normalizeQuota, normalizeBalances, consoleJson, ConsoleError, type QuotaSnapshot } from './quota.js';
import { record, combinedSignal } from './util.js';

export type VelaRunner = (args: readonly string[], signal: AbortSignal, profile?: string) => Promise<unknown>;
export function locateVela(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string | undefined {
  const explicit = env.OPENDESIGN_VELA_PATH?.trim();
  if (explicit && isAbsolute(explicit) && existsSync(explicit)) return explicit;
  if (platform !== 'win32' || !env.LOCALAPPDATA) return;
  const path = join(env.LOCALAPPDATA, 'Programs', 'Open Design', 'resources', 'open-design', 'bin', 'vela.exe');
  return existsSync(path) ? path : undefined;
}
/** Read-only official CLI, fixed argv and bounded output; stderr is never projected. */
export const runVela: VelaRunner = (args, signal, profile) => new Promise((resolve, reject) => {
  const binary = locateVela();
  if (!binary) return reject(new ConsoleError('network'));
  execFile(binary, [...args], { timeout: 8000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, signal, encoding: 'utf8', env: { ...process.env, ...(profile ? { VELA_PROFILE: profile, OPEN_DESIGN_AMR_PROFILE: profile } : {}) } }, (error, stdout) => {
    if (error) return reject(new ConsoleError('network'));
    try { resolve(JSON.parse(stdout)); } catch { reject(new ConsoleError('response')); }
  });
});
/** Desktop tokens can have narrower scopes than console cookies; never invent an HTTP funding-check. */
export async function readDesktopQuota(session: AuthSession, signal?: AbortSignal, runner: VelaRunner = runVela, fetcher = fetch): Promise<QuotaSnapshot> {
  const deadline = combinedSignal(signal, 18000);
  const cli = (async () => {
    const workspace = await runner(['team-projects', 'list'], deadline, session.profile);
    if (!record(workspace) || typeof workspace.workspaceId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/u.test(workspace.workspaceId)) throw new ConsoleError('response');
    const funding = await runner(['billing', 'funding-check', '--workspace-id', workspace.workspaceId, '--format', 'json'], deadline, session.profile);
    if (!record(funding) || !record(funding.codingPlan)) throw new ConsoleError('response');
    return { ...normalizeQuota(funding.codingPlan), ...(typeof funding.balanceUsd === 'string' ? { balance: funding.balanceUsd } : {}) };
  })();
  const [wallet, funding] = await Promise.allSettled([
    consoleJson(`${session.apiUrl}/api/v1/wallet/balance`, session, deadline, fetcher),
    cli,
  ]);
  const walletBalances = wallet.status === 'fulfilled' ? normalizeBalances(wallet.value) : {};
  const cliBalances = funding.status === 'fulfilled' && 'balance' in funding.value ? normalizeBalances({ balanceUsd: funding.value.balance }) : {};
  const windows = funding.status === 'fulfilled' ? funding.value.windows : [];
  const balances = { ...cliBalances, ...walletBalances };
  if (!windows.length && !Object.keys(balances).length) {
    if (wallet.status === 'rejected' && wallet.reason instanceof ConsoleError && (wallet.reason.kind === 'auth' || wallet.reason.kind === 'permission')) throw wallet.reason;
    throw new ConsoleError('network');
  }
  const tier = (funding.status === 'fulfilled' ? funding.value.tier : undefined) ?? session.plan;
  const eligible = funding.status === 'fulfilled' ? funding.value.eligible : undefined;
  return { state: 'partial', source: 'desktop', updatedAt: new Date().toISOString(), windows, balances,
    ...(tier ? { tier } : {}), ...(eligible === undefined ? {} : { eligible }),
    note: '桌面登录态部分接口权限受限；未读到的分池显示未知。如需完整分池，请在连接页登录并关闭“优先桌面登录态”。',
  };
}
