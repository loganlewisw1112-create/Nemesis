import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type RuntimeSidecarEventType = 'runtime_started' | 'runtime_sample' | 'runtime_transition' | 'runtime_finalized';

export interface RuntimeSidecarEventV2 {
  schemaVersion: 2;
  runId: string;
  sequence: number;
  at: number;
  type: RuntimeSidecarEventType;
  payload: Readonly<Record<string, unknown>>;
  previousHash: string;
  hash: string;
}

export interface RuntimeSidecarReplay {
  events: RuntimeSidecarEventV2[];
  finalHash: string;
  integrityError?: string;
}

function eventHash(event: Omit<RuntimeSidecarEventV2, 'hash'>): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

function fileHash(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function replayRuntimeSidecar(filePath: string): RuntimeSidecarReplay {
  if (!fs.existsSync(filePath)) return { events: [], finalHash: 'GENESIS', integrityError: 'runtime sidecar is missing' };
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean);
  const events: RuntimeSidecarEventV2[] = [];
  let previousHash = 'GENESIS';
  for (let index = 0; index < lines.length; index += 1) {
    try {
      const event = JSON.parse(lines[index]!) as RuntimeSidecarEventV2;
      const { hash, ...body } = event;
      if (event.schemaVersion !== 2
        || event.sequence !== index + 1
        || event.previousHash !== previousHash
        || eventHash(body) !== hash) {
        return { events, finalHash: previousHash, integrityError: `runtime sidecar integrity failure at sequence ${index + 1}` };
      }
      events.push(event);
      previousHash = event.hash;
    } catch (error) {
      return {
        events,
        finalHash: previousHash,
        integrityError: `runtime sidecar parse failure at sequence ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { events, finalHash: previousHash };
}

/**
 * Append-only operational evidence kept outside the campaign ledger. Every
 * append is fsynced so a process crash cannot create a historical health pass.
 */
export class RuntimeEvidenceSidecar {
  private sequence = 0;
  private previousHash = 'GENESIS';
  private finalized = false;

  private constructor(readonly filePath: string, readonly runId: string) {}

  static create(filePath: string, input: {
    runId: string;
    gitCommit: string;
    configurationHash: string;
    healthPolicyHash: string;
    productionArtifactHash: string;
    soakVerificationReceiptHash: string;
    at?: number;
  }): RuntimeEvidenceSidecar {
    if (!/^[a-f0-9]{64}$/i.test(input.productionArtifactHash)) {
      throw new Error('production artifact hash must be an explicit SHA-256 digest');
    }
    if (!/^[a-f0-9]{64}$/i.test(input.soakVerificationReceiptHash)) {
      throw new Error('soak verification receipt hash must be an explicit SHA-256 digest');
    }
    if (fs.existsSync(filePath)) throw new Error(`runtime sidecar already exists: ${filePath}`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const store = new RuntimeEvidenceSidecar(filePath, input.runId);
    store.append('runtime_started', {
      gitCommit: input.gitCommit,
      configurationHash: input.configurationHash,
      healthPolicyHash: input.healthPolicyHash,
      productionArtifactHash: input.productionArtifactHash,
      soakVerificationReceiptHash: input.soakVerificationReceiptHash,
    }, input.at);
    return store;
  }

  appendSample(payload: Readonly<Record<string, unknown>>, at = Date.now()): RuntimeSidecarEventV2 {
    return this.append('runtime_sample', payload, at);
  }

  appendTransition(payload: Readonly<Record<string, unknown>>, at = Date.now()): RuntimeSidecarEventV2 {
    return this.append('runtime_transition', payload, at);
  }

  finalize(payload: Readonly<Record<string, unknown>> = {}, at = Date.now()): string {
    if (!this.finalized) {
      this.append('runtime_finalized', payload, at);
      this.finalized = true;
    }
    const replay = replayRuntimeSidecar(this.filePath);
    if (replay.integrityError) throw new Error(replay.integrityError);
    return fileHash(this.filePath);
  }

  lastHash(): string {
    return this.previousHash;
  }

  private append(type: RuntimeSidecarEventType, payload: Readonly<Record<string, unknown>>, at = Date.now()): RuntimeSidecarEventV2 {
    if (this.finalized) throw new Error('runtime sidecar is finalized');
    const body: Omit<RuntimeSidecarEventV2, 'hash'> = {
      schemaVersion: 2,
      runId: this.runId,
      sequence: ++this.sequence,
      at,
      type,
      payload: structuredClone(payload),
      previousHash: this.previousHash,
    };
    const event: RuntimeSidecarEventV2 = { ...body, hash: eventHash(body) };
    const fd = fs.openSync(this.filePath, 'a');
    try {
      fs.writeSync(fd, `${JSON.stringify(event)}\n`, undefined, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.previousHash = event.hash;
    return event;
  }
}
