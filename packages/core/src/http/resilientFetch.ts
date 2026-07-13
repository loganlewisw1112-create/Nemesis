export interface ResilientFetchOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  label?: string;
}

const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/xml, application/rss+xml, */*',
  'User-Agent': 'NEMESIS/1.0 (Kalshi Desktop)',
};

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function resilientFetch(
  url: string,
  opts: ResilientFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 12_000,
    retries = 3,
    retryDelayMs = 400,
    label = url,
    headers,
    signal: externalSignal,
    ...init
  } = opts;

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new Error(`${label} aborted`);
    }
    const controller = new AbortController();
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...DEFAULT_HEADERS, ...headers as Record<string, string> },
        signal: controller.signal,
      });
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`${label} HTTP ${res.status}`);
        if (attempt < retries) {
          await sleep(retryDelayMs * (attempt + 1));
          continue;
        }
      }
      return res;
    } catch (e) {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', abortFromExternal);
      lastError = e instanceof Error ? e : new Error(String(e));
      if (externalSignal?.aborted) {
        throw externalSignal.reason instanceof Error ? externalSignal.reason : lastError;
      }
      if (attempt < retries) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

export async function fetchJson<T>(
  url: string,
  opts: ResilientFetchOptions = {},
): Promise<T> {
  const res = await resilientFetch(url, opts);
  if (!res.ok) {
    throw new Error(`${opts.label ?? url} HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchText(
  url: string,
  opts: ResilientFetchOptions = {},
): Promise<string> {
  const res = await resilientFetch(url, opts);
  if (!res.ok) {
    throw new Error(`${opts.label ?? url} HTTP ${res.status}`);
  }
  return res.text();
}
