import { randomBytes, timingSafeEqual } from 'node:crypto';

export const DEFAULT_BRIDGE_HOST = '127.0.0.1';

type RandomBytesFn = (size: number) => Buffer;

export interface BridgeAuth {
  token: string;
  ephemeral: boolean;
}

function normalizeHost(host: string): string {
  return host.trim().replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

function is127Address(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4 || parts[0] !== '127') return false;
  return parts.every((part) => {
    if (!/^\d+$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

export function isLoopbackHost(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0:0:0:0:0:0:0:1'
    || is127Address(normalized);
}

export function resolveBridgeHost(env: NodeJS.ProcessEnv): string {
  const host = (env.NEMESIS_BRIDGE_HOST?.trim() || DEFAULT_BRIDGE_HOST);
  if (!isLoopbackHost(host) && env.NEMESIS_ALLOW_REMOTE_BRIDGE !== 'true') {
    throw new Error(`Refusing non-loopback NEMESIS bridge host "${host}" without NEMESIS_ALLOW_REMOTE_BRIDGE=true`);
  }
  return host;
}

export function createBridgeAuth(
  env: NodeJS.ProcessEnv,
  randomBytesFn: RandomBytesFn = randomBytes,
): BridgeAuth {
  const configured = env.NEMESIS_BRIDGE_TOKEN?.trim();
  if (configured) return { token: configured, ephemeral: false };
  return { token: randomBytesFn(32).toString('hex'), ephemeral: true };
}

export function appendBridgeTokenToUrl(baseUrl: string, token: string): string {
  const url = new URL(baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function equalTokens(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

export function isBridgeRequestAuthenticated(requestUrl: string | undefined, expectedToken: string): boolean {
  if (!expectedToken) return false;
  try {
    const url = new URL(requestUrl ?? '/', 'ws://127.0.0.1');
    const token = url.searchParams.get('token') ?? '';
    return equalTokens(token, expectedToken);
  } catch {
    return false;
  }
}
