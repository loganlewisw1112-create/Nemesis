import { afterEach, describe, expect, it, vi } from 'vitest';
import { resilientFetch } from './resilientFetch.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('resilientFetch abort propagation', () => {
  it('aborts the active request and does not enter another retry', async () => {
    const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      if (!signal) throw new Error('missing signal');
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const controller = new AbortController();
    const pending = resilientFetch('https://example.test', { signal: controller.signal, retries: 3 });
    controller.abort(new Error('operator timeout'));

    await expect(pending).rejects.toThrow('operator timeout');
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
