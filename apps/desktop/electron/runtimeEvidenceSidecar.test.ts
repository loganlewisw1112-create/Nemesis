import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { replayRuntimeSidecar, RuntimeEvidenceSidecar } from './runtimeEvidenceSidecar.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('RuntimeEvidenceSidecar', () => {
  const productionArtifactHash = 'a'.repeat(64);
  const soakVerificationReceiptHash = 'b'.repeat(64);

  it('writes a hash-linked fsynced stream and produces a stable final file hash', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-runtime-sidecar-'));
    roots.push(root);
    const filePath = path.join(root, 'runtime.jsonl');
    const sidecar = RuntimeEvidenceSidecar.create(filePath, {
      runId: 'r10',
      gitCommit: 'abc',
      configurationHash: 'cfg',
      healthPolicyHash: 'health',
      productionArtifactHash,
      soakVerificationReceiptHash,
      at: 1,
    });
    sidecar.appendSample({ state: 'healthy' }, 2);
    sidecar.appendTransition({ action: 'start' }, 3);
    const hash = sidecar.finalize({ cleanShutdown: true }, 4);
    const replay = replayRuntimeSidecar(filePath);
    expect(replay.integrityError).toBeUndefined();
    expect(replay.events.map((event) => event.type)).toEqual([
      'runtime_started',
      'runtime_sample',
      'runtime_transition',
      'runtime_finalized',
    ]);
    expect(replay.events[0]?.payload).toMatchObject({
      productionArtifactHash,
      soakVerificationReceiptHash,
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(() => sidecar.appendSample({}, 5)).toThrow(/finalized/);
  });

  it('fails replay closed after a payload is altered', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-runtime-sidecar-'));
    roots.push(root);
    const filePath = path.join(root, 'runtime.jsonl');
    const sidecar = RuntimeEvidenceSidecar.create(filePath, {
      runId: 'r10', gitCommit: 'abc', configurationHash: 'cfg', healthPolicyHash: 'health', productionArtifactHash, soakVerificationReceiptHash, at: 1,
    });
    sidecar.appendSample({ state: 'healthy' }, 2);
    fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replace('healthy', 'failed'), 'utf8');
    expect(replayRuntimeSidecar(filePath).integrityError).toMatch(/sequence 2/);
  });

  it('fails closed when the runtime evidence destination cannot be created', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-runtime-sidecar-disk-failure-'));
    roots.push(root);
    const parentIsAFile = path.join(root, 'not-a-directory');
    fs.writeFileSync(parentIsAFile, 'occupied', 'utf8');
    expect(() => RuntimeEvidenceSidecar.create(path.join(parentIsAFile, 'runtime.jsonl'), {
      runId: 'r10', gitCommit: 'abc', configurationHash: 'cfg', healthPolicyHash: 'health', productionArtifactHash, soakVerificationReceiptHash, at: 1,
    })).toThrow();
  });

  it('refuses to start without explicit upstream evidence hashes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nemesis-runtime-sidecar-identity-'));
    roots.push(root);
    expect(() => RuntimeEvidenceSidecar.create(path.join(root, 'runtime.jsonl'), {
      runId: 'r10',
      gitCommit: 'abc',
      configurationHash: 'cfg',
      healthPolicyHash: 'health',
      productionArtifactHash: '',
      soakVerificationReceiptHash,
      at: 1,
    })).toThrow(/production artifact hash/i);
  });
});
