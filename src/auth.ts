// OpenDesign CoRouter — desktop login state and session resolution.
//
// Contract source: OpenDesign desktop daemon (`resources/app/prebundled/daemon/chunks/*.mjs`,
// `configDir()` / `amrConfigPath()` / `readRawVelaControlApiContext()` / `readVelaProfileConfigSnapshot()`)
// and `vela.exe` (profile struct tags). See docs/quota-evidence.md §1.
//
// This module never prints, logs or echoes credential material. Every failure path
// reports a *reason code*, never the offending text, so an unreadable or hostile
// config can never leak its contents through an error message.
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';
import type { Session, SessionSource } from './quota.js';
import { record, safeSecret } from './util.js';

/** Control-plane origin the desktop build ships with (open-design-config.json / daemon default). */
export const DEFAULT_API_URL = 'https://amr-api.open-design.ai';
/** The one host this plugin is willing to send an account token to. */
export const API_HOST = 'amr-api.open-design.ai';

/** Profiles the official client recognizes; anything else falls back to `prod`. */
export const DESKTOP_PROFILES = ['prod', 'test', 'feature-test', 'local'] as const;
export type DesktopProfile = (typeof DESKTOP_PROFILES)[number];
export const DEFAULT_PROFILE: DesktopProfile = 'prod';

/** Reference names holding a console session cookie, read through the credential seam. */
export const COOKIE_ENV_REFS = ['OPEN_DESIGN_COOKIE', 'OPEN_DESIGN_SESSION'] as const;

/**
 * Exactly one accepted origin. `apiUrl` comes from a file this plugin does not own, so an
 * edited or attacker-supplied value must never receive the account token: without this gate,
 * pointing `apiUrl` anywhere would exfiltrate the desktop `controlKey`. A sibling subdomain is
 * not accepted either — no widening "just in case" (`*.open-design.ai` would already be wrong).
 */
export function isOfficialApiUrl(raw: string): boolean {
  let url: URL;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (url.search || url.hash) return false;
  if (url.pathname !== '/' && url.pathname !== '') return false;
  return url.hostname.toLowerCase() === API_HOST && !url.port;
}

/** Canonical `https://host` form, or `undefined` when the value is not an official origin. */
export function normalizeApiUrl(raw: string | undefined): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return undefined;
  if (!isOfficialApiUrl(value)) return undefined;
  const url = new URL(value);
  return `https://${url.hostname.toLowerCase()}`;
}

/** Profile selection matches the client: `OPEN_DESIGN_AMR_PROFILE` wins over `VELA_PROFILE`. */
export function resolveProfile(env: NodeJS.ProcessEnv = process.env): DesktopProfile {
  const raw = (env.OPEN_DESIGN_AMR_PROFILE ?? env.VELA_PROFILE ?? '').trim();
  return (DESKTOP_PROFILES as readonly string[]).includes(raw) ? raw as DesktopProfile : DEFAULT_PROFILE;
}

/** `AMR_HOME` (with `~` / `~/x` expansion), else `<home>/.amr` — the client's `configDir()`. */
export function desktopConfigDir(env: NodeJS.ProcessEnv = process.env, home = osHomedir()): string {
  const raw = (env.AMR_HOME ?? '').trim();
  if (!raw) return join(home, '.amr');
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(home, raw.slice(2));
  return raw;
}

/** Full path of the desktop credential file. */
export function desktopConfigPath(env: NodeJS.ProcessEnv = process.env, home = osHomedir()): string {
  return join(desktopConfigDir(env, home), 'config.json');
}

/** What the desktop file says about one profile. Values are held in memory only. */
export interface DesktopCredential {
  profile: DesktopProfile;
  controlKey: string;
  /** Present only when the profile carries an official origin. */
  apiUrl?: string;
  plan?: string;
  /** `runtimeKey` present means the desktop considers itself signed in. */
  signedIn: boolean;
}

export type DesktopRead =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'invalid' }
  | { state: 'incomplete'; profile: DesktopProfile }
  /** The profile's `apiUrl` is not the one accepted origin: never used, and never retried elsewhere. */
  | { state: 'unsafe-api-url'; profile: DesktopProfile }
  /** A non-`prod` profile: its token belongs to another environment, so it is not sent to prod. */
  | { state: 'unsupported-profile'; profile: DesktopProfile }
  | { state: 'credential'; credential: DesktopCredential };

/**
 * Parse `config.json` text. Never throws and never returns the raw text, so callers can
 * treat a hostile file as "absent" without risking a leak. `state: 'invalid'` means the
 * JSON or its shape was not what the client writes.
 */
export function parseDesktopConfigText(text: string, profile: DesktopProfile = DEFAULT_PROFILE): DesktopRead {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return { state: 'invalid' }; }
  if (!record(parsed)) return { state: 'invalid' };
  const profiles = parsed['profiles'];
  if (!record(profiles)) return { state: 'invalid' };
  const entry = profiles[profile];
  // A config for other profiles only is "no credential here", not "invalid".
  if (entry === undefined) return { state: 'incomplete', profile };
  if (!record(entry)) return { state: 'invalid' };
  const controlKey = typeof entry['controlKey'] === 'string' ? entry['controlKey'].trim() : '';
  const runtimeKey = typeof entry['runtimeKey'] === 'string' ? entry['runtimeKey'].trim() : '';
  const rawApiUrl = typeof entry['apiUrl'] === 'string' ? entry['apiUrl'].trim() : '';
  const user = record(entry['user']) ? entry['user'] : undefined;
  const plan = typeof user?.['plan'] === 'string' ? user['plan'].trim() : '';
  if (!controlKey) return { state: 'incomplete', profile };
  try { safeSecret(controlKey); } catch { return { state: 'invalid' }; }
  const apiUrl = normalizeApiUrl(rawApiUrl);
  // A stored origin that is not the accepted one is reported, not discarded: silently falling
  // back to the default host is exactly how one environment's token would end up at another
  // environment's endpoint.
  if (rawApiUrl && !apiUrl) return { state: 'unsafe-api-url', profile };
  // Only `prod` is supported. Sending another profile's token to the prod endpoint (or the
  // reverse) would mix accounts, so the mismatch stops here.
  if (profile !== DEFAULT_PROFILE) return { state: 'unsupported-profile', profile };
  return {
    state: 'credential',
    credential: {
      profile,
      controlKey,
      ...(apiUrl === undefined ? {} : { apiUrl }),
      ...(plan ? { plan } : {}),
      signedIn: runtimeKey.length > 0,
    },
  };
}

export interface DesktopDeps {
  env?: NodeJS.ProcessEnv;
  home?: string;
  profile?: DesktopProfile;
  readFile?: (path: string) => Promise<string>;
}

/**
 * Read the desktop credential, distinguishing "no desktop installed or signed out"
 * (`missing` / `incomplete`) from "there is a file but it cannot be used"
 * (`unreadable` / `invalid`). The two must not be conflated: the first is normal for
 * users without the desktop app, the second deserves a different hint.
 */
export async function readDesktopCredential(deps: DesktopDeps = {}): Promise<DesktopRead> {
  const env = deps.env ?? process.env;
  const profile = deps.profile ?? resolveProfile(env);
  const path = desktopConfigPath(env, deps.home ?? osHomedir());
  const readFile = deps.readFile ?? ((file: string) => fsReadFile(file, 'utf8'));
  let text: string;
  try { text = await readFile(path); }
  catch (error) {
    const code = record(error) && typeof error['code'] === 'string' ? error['code'] : '';
    return code === 'ENOENT' || code === 'ENOTDIR' ? { state: 'missing' } : { state: 'unreadable' };
  }
  return parseDesktopConfigText(text, profile);
}

/** Cookie payload persisted through the credential seam as a `grant` record. */
export interface CookieLoginGrant {
  cookie: string;
  /** Legacy cookie expiry only; never applied to device tokens. */
  expiresAt?: number;
}
export interface DeviceLoginGrant {
  kind: 'device';
  controlKey: string;
  runtimeKey: string;
  savedAt?: string;
}
export type LoginGrant = CookieLoginGrant | DeviceLoginGrant;

/** Validate both keys as one snapshot; never combine an incomplete grant with another source. */
export function deviceGrant(value: unknown): DeviceLoginGrant | undefined {
  if (!record(value) || value.kind !== 'device' || typeof value.controlKey !== 'string' || typeof value.runtimeKey !== 'string') return;
  try {
    const controlKey = safeSecret(value.controlKey), runtimeKey = safeSecret(value.runtimeKey);
    if ([controlKey, runtimeKey].some(key => key.length > 8192 || /\s/u.test(key))) return;
    return { kind: 'device', controlKey, runtimeKey, ...(typeof value.savedAt === 'string' ? { savedAt: value.savedAt } : {}) };
  } catch { return undefined; }
}

/** Device runtime credentials may only reach this exact HTTPS origin, never a custom gateway. */
export function isOfficialRuntimeUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.origin === 'https://amr-link.open-design.ai' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}

export type AuthSource = 'desktop' | 'login' | 'environment';

export interface AuthSession extends Session {
  source: SessionSource;
  via: AuthSource;
  apiUrl: string;
  /** Desktop profile name, when the session came from the desktop file. */
  profile?: string;
  plan?: string;
}

export type AuthReason =
  | 'no-credential'
  | 'desktop-incomplete'
  | 'desktop-unreadable'
  | 'unsafe-api-url'
  | 'unsupported-profile';

export type AuthOutcome =
  | { state: 'ready'; session: AuthSession; warnings: AuthReason[] }
  | { state: 'need-login'; reason: AuthReason; warnings: AuthReason[] };

export interface AuthDeps extends DesktopDeps {
  /** Allow reading the desktop login state; `false` for users who only use this plugin's login. */
  useDesktop?: boolean;
  /** Read the persisted login grant (Host-owned credential store). */
  readGrant?: () => Promise<LoginGrant | undefined>;
  /** Resolve an environment-variable reference (Host-owned credential seam). */
  resolveRef?: (ref: string) => Promise<string | undefined>;
  now?: () => number;
}

function cookieHeader(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || !value.includes('=')) return undefined;
  try { return safeSecret(value); } catch { return undefined; }
}

/** Desktop `controlKey` as a Bearer header (daemon evidence: `/api/v1/wallet/balance`). */
export function desktopSession(credential: DesktopCredential, apiUrl = credential.apiUrl ?? DEFAULT_API_URL): AuthSession {
  const base = normalizeApiUrl(apiUrl) ?? DEFAULT_API_URL;
  return {
    headers: { authorization: `Bearer ${safeSecret(credential.controlKey)}` },
    source: 'desktop',
    via: 'desktop',
    apiUrl: base,
    profile: credential.profile,
    ...(credential.plan ? { plan: credential.plan } : {}),
  };
}

/** Device control token: Bearer on the official control plane only. No inferred token expiry. */
export function deviceSession(tokens: { controlKey: string } | string): AuthSession {
  const controlKey = typeof tokens === 'string' ? tokens : tokens.controlKey;
  return { headers: { authorization: `Bearer ${safeSecret(controlKey)}` }, source: 'login', via: 'login', apiUrl: DEFAULT_API_URL, credentialType: 'device' };
}

/** A persisted or environment-supplied console cookie as a `cookie` header. */
export function cookieSession(cookie: string, source: SessionSource, apiUrl = DEFAULT_API_URL): AuthSession | undefined {
  const header = cookieHeader(cookie);
  if (!header) return undefined;
  return {
    headers: { cookie: header },
    source,
    via: source === 'environment' ? 'environment' : 'login',
    apiUrl: normalizeApiUrl(apiUrl) ?? DEFAULT_API_URL,
  };
}

/**
 * Resolve the session in the order the user asked for: **desktop first**, then the
 * device grant saved by this plugin, then legacy cookies and environment references.
 *
 * A desktop config whose `apiUrl` is not an official origin is *skipped*, not used: the
 * token must not travel to a host the plugin cannot vouch for. The skip is reported as a
 * warning so a UI can explain why the desktop session was ignored.
 */
export async function resolveSession(deps: AuthDeps = {}): Promise<AuthOutcome> {
  const env = deps.env ?? process.env;
  const warnings: AuthReason[] = [];
  const now = deps.now ?? Date.now;

  if (deps.useDesktop !== false) {
    const desktop = await readDesktopCredential(deps);
    if (desktop.state === 'credential') {
      const envApiUrl = (env.VELA_API_URL ?? '').trim();
      // An environment-supplied origin passes through the same single-host gate. A rejected
      // value means "desktop off", not "use the token on the default host": that substitution
      // is precisely the cross-environment leak this check exists to prevent.
      if (envApiUrl && !normalizeApiUrl(envApiUrl)) {
        warnings.push('unsafe-api-url');
      } else {
        return { state: 'ready', session: desktopSession(desktop.credential, envApiUrl || DEFAULT_API_URL), warnings };
      }
    } else if (desktop.state === 'unsafe-api-url') {
      warnings.push('unsafe-api-url');
    } else if (desktop.state === 'unsupported-profile') {
      warnings.push('unsupported-profile');
    } else if (desktop.state === 'incomplete') {
      warnings.push('desktop-incomplete');
    } else if (desktop.state === 'unreadable' || desktop.state === 'invalid') {
      warnings.push('desktop-unreadable');
    }
  }

  if (deps.readGrant) {
    let grant: LoginGrant | undefined;
    try { grant = await deps.readGrant(); } catch { grant = undefined; }
    if (grant && 'kind' in grant && grant.kind === 'device') {
      const device = deviceGrant(grant);
      if (device) return { state: 'ready', session: deviceSession(device), warnings };
    } else if (grant && 'cookie' in grant) {
      const expiry = typeof grant.expiresAt === 'number' && Number.isFinite(grant.expiresAt) ? grant.expiresAt : 0;
      if (expiry === 0 || expiry > now()) {
        const session = cookieSession(grant.cookie, 'login');
        if (session) return { state: 'ready', session, warnings };
      }
    }
  }

  if (deps.resolveRef) {
    for (const ref of COOKIE_ENV_REFS) {
      let value: string | undefined;
      try { value = await deps.resolveRef(ref); } catch { value = undefined; }
      if (!value) continue;
      const session = cookieSession(value, 'environment');
      if (session) return { state: 'ready', session, warnings };
    }
  }

  return { state: 'need-login', reason: warnings[0] ?? 'no-credential', warnings };
}

/** Endpoint builders for a resolved origin, mirroring `quota.ts` for non-default hosts. */
export function endpoints(apiUrl: string) {
  const base = `${apiUrl}/api/v1`;
  return {
    base,
    current: `${base}/workspaces/current`,
    summary: `${base}/billing/summary`,
    usage: (workspaceId: string) => `${base}/workspaces/${encodeURIComponent(workspaceId)}/billing/coding-plan-usage`,
  };
}
