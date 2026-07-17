export interface SoakSeriesManifest {
  schemaVersion: 3;
  seriesId: string;
  attemptId: string;
  parentAttemptId: string | null;
  retryOrdinal: 0 | 1 | 2;
  gitCommit: string;
  configurationHash: string;
  healthPolicyHash: string;
  productionArtifactHash: string;
  readinessReceiptSha256: string;
  sampleChainHead: string;
  sampleCount: number;
  cutoffStatus: 'passed' | 'failed';
  cleanShutdown: boolean;
}

export interface ReadinessReceipt {
  schemaVersion: 1;
  receiptType: 'ReadinessReceipt';
  runId: string;
  verifiedAt: number;
  passed: boolean;
  timerStarted: false;
  gitCommit: string;
  productionArtifactHash: string;
  holdMinutes?: number;
  matchingArtifactHashes?: boolean;
  cleanShutdown?: boolean;
  acceptanceFailures: string[];
}

export interface EvidenceVerificationReceipt {
  schemaVersion: 1;
  receiptType: 'EvidenceVerificationReceipt';
  runType: 'production-stress-soak' | 'r10-instrumentation' | 'seven-hour';
  runId: string;
  verifiedAt: number;
  verified: boolean;
  failures: string[];
  gitCommit: string;
  configurationHash: string;
  healthPolicyHash: string;
  receiptHash: string;
}
