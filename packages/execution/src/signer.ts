import { createSign, constants } from 'node:crypto';

export function signKalshiRequest(
  privateKeyPem: string,
  timestampMs: number,
  method: string,
  path: string,
): string {
  const message = `${timestampMs}${method}${path}`;
  const signer = createSign('RSA-SHA256');
  signer.update(message);
  signer.end();
  return signer.sign(
  {
    key: privateKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
  },
  'base64',
  );
}

export function authHeaders(
  apiKeyId: string,
  privateKeyPem: string,
  method: string,
  path: string,
): Record<string, string> {
  const ts = Date.now().toString();
  const sig = signKalshiRequest(privateKeyPem, Number(ts), method, path);
  return {
    'KALSHI-ACCESS-KEY': apiKeyId,
    'KALSHI-ACCESS-SIGNATURE': sig,
    'KALSHI-ACCESS-TIMESTAMP': ts,
  };
}
