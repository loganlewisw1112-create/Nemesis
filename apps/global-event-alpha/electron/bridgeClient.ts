const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:7430';

export function resolveNemesisBridgeUrl(env: NodeJS.ProcessEnv): string {
  const baseUrl = env.NEMESIS_BRIDGE_URL?.trim() || DEFAULT_BRIDGE_URL;
  const url = new URL(baseUrl);
  const token = env.NEMESIS_BRIDGE_TOKEN?.trim();
  if (token) url.searchParams.set('token', token);
  return url.toString();
}
