import type { MetricObservation, MetricSummary } from './types.js';

export class MetricsEngine {
  static summarize(observations: MetricObservation[]): MetricSummary {
    if (observations.length === 0) {
      return {
        brier_score: 0,
        hit_rate: 0,
        pnl: 0,
        edge_capture: 0,
        blocked_ticket_accuracy: 0,
      };
    }
    const brier = observations.reduce((sum, obs) => sum + ((obs.predicted - obs.actual) ** 2), 0) / observations.length;
    const hits = observations.filter((obs) => (obs.predicted >= 0.5 ? 1 : 0) === obs.actual).length;
    const blockMatches = observations.filter((obs) => obs.blocked === obs.shouldBlock).length;
    return {
      brier_score: brier,
      hit_rate: hits / observations.length,
      pnl: observations.reduce((sum, obs) => sum + obs.pnl, 0),
      edge_capture: observations.reduce((sum, obs) => sum + obs.edgeCaptured, 0) / observations.length,
      blocked_ticket_accuracy: blockMatches / observations.length,
    };
  }
}
