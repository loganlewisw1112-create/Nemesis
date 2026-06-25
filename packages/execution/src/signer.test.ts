import { describe, expect, it } from 'vitest';
import { authHeaders } from '../src/signer.js';
import { generateKeyPairSync } from 'node:crypto';

describe('signer', () => {
  it('produces kalshi auth headers', () => {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    const headers = authHeaders('key-id', pem, 'GET', '/trade-api/v2/portfolio/balance');
    expect(headers['KALSHI-ACCESS-KEY']).toBe('key-id');
    expect(headers['KALSHI-ACCESS-SIGNATURE']).toBeTruthy();
    expect(headers['KALSHI-ACCESS-TIMESTAMP']).toBeTruthy();
  });
});
