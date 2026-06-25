import { MetricsEngine } from './MetricsEngine.js';
import type { MetricObservation, MetricSummary, ReplayEvent } from './types.js';

export interface TicketAutopsyStep {
  timestamp: number;
  event_type: ReplayEvent['type'];
  summary: string;
  payload: Record<string, unknown>;
}

export interface TicketAutopsyResult {
  ticker: string;
  decision_path: TicketAutopsyStep[];
  summary: string;
}

export interface TournamentModelInput {
  model_version: string;
  predictions: number[];
  actuals: Array<0 | 1>;
  pnl: number[];
  blocked?: boolean[];
  shouldBlock?: boolean[];
}

export interface ModelTournamentInput {
  replay_id: string;
  models: TournamentModelInput[];
}

export interface ModelTournamentResultRow {
  model_version: string;
  rank: number;
  metrics: MetricSummary;
}

export interface ModelTournamentResult {
  replay_id: string;
  results: ModelTournamentResultRow[];
}

function eventTicker(event: ReplayEvent): string | null {
  const ticker = event.payload.ticker;
  return typeof ticker === 'string' ? ticker : null;
}

function summarizeEvent(event: ReplayEvent): string {
  if (event.type === 'snapshot') {
    const price = typeof event.payload.price === 'number' ? ` at ${event.payload.price.toFixed(2)}` : '';
    return `Snapshot observed${price}.`;
  }
  if (event.type === 'brain-output') {
    const probability = typeof event.payload.probability === 'number'
      ? ` probability ${event.payload.probability.toFixed(2)}`
      : '';
    return `Brain output emitted${probability}.`;
  }
  if (event.type === 'decision') {
    const action = typeof event.payload.action === 'string' ? event.payload.action : 'review';
    return `Decision recorded: ${action}.`;
  }
  if (event.type === 'trade') return 'Trade print observed.';
  return 'Public data event observed.';
}

function csvCell(value: unknown): string {
  if (value == null) return '';
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export class TicketAutopsy {
  static fromEvents(ticker: string, events: ReplayEvent[]): TicketAutopsyResult {
    const decisionTypes = new Set<ReplayEvent['type']>(['snapshot', 'brain-output', 'decision']);
    const decisionPath = events
      .filter((event) => decisionTypes.has(event.type))
      .filter((event) => eventTicker(event) === ticker)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((event) => ({
        timestamp: event.timestamp,
        event_type: event.type,
        summary: summarizeEvent(event),
        payload: event.payload,
      }));

    return {
      ticker,
      decision_path: decisionPath,
      summary: `${decisionPath.length} decision events reviewed for ${ticker}.`,
    };
  }
}

export class ModelTournament {
  static run(input: ModelTournamentInput): ModelTournamentResult {
    const rows = input.models.map((model) => {
      const count = Math.min(model.predictions.length, model.actuals.length, model.pnl.length);
      const observations: MetricObservation[] = [];
      for (let index = 0; index < count; index += 1) {
        observations.push({
          predicted: model.predictions[index],
          actual: model.actuals[index],
          pnl: model.pnl[index],
          edgeCaptured: Math.max(0, Math.abs(model.predictions[index] - 0.5)),
          blocked: model.blocked?.[index] ?? false,
          shouldBlock: model.shouldBlock?.[index] ?? false,
        });
      }
      return {
        model_version: model.model_version,
        rank: 0,
        metrics: MetricsEngine.summarize(observations),
      };
    });

    rows.sort((a, b) => {
      if (b.metrics.pnl !== a.metrics.pnl) return b.metrics.pnl - a.metrics.pnl;
      if (a.metrics.brier_score !== b.metrics.brier_score) return a.metrics.brier_score - b.metrics.brier_score;
      return b.metrics.hit_rate - a.metrics.hit_rate;
    });

    return {
      replay_id: input.replay_id,
      results: rows.map((row, index) => ({ ...row, rank: index + 1 })),
    };
  }
}

export class AnalyticsExporter {
  static toJson(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }

  static toCsv(rows: Array<Record<string, unknown>>): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]);
    const lines = [
      headers.join(','),
      ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(',')),
    ];
    return lines.join('\n');
  }
}
