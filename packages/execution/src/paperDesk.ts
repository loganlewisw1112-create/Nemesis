import { kalshiFeeForOrder } from '@nemesis/core';
import type { PaperPortfolio, PaperPosition, ThesisCard, FillMetadata } from '@nemesis/core';
import { markToMarketPortfolio } from './pnlEngine.js';

export class PaperDesk {
  private portfolio: PaperPortfolio;

  constructor(startingCash = 1000) {
    this.portfolio = {
      cash: startingCash,
      startingCash,
      positions: [],
      trades: [],
      realizedPnl: 0,
    };
  }

  load(data: PaperPortfolio) {
    this.portfolio = data;
  }

  snapshot(): PaperPortfolio {
    return JSON.parse(JSON.stringify(this.portfolio));
  }

  openPosition(
    card: ThesisCard,
    contracts: number,
    fillPrice: number,
    fillMeta?: FillMetadata,
    category?: string,
  ): { ok: boolean; error?: string; position?: PaperPosition } {
    if (contracts < 1) return { ok: false, error: 'minimum 1 contract' };
    const cost = fillPrice * contracts;
    const fees = kalshiFeeForOrder(fillPrice, contracts);
    const total = cost + fees;
    if (total > this.portfolio.cash) return { ok: false, error: 'insufficient paper cash' };

    const existing = this.portfolio.positions.find(
      (p) => p.ticker === card.ticker && p.side === card.side,
    );
    let positionId: string;
    if (existing) {
      const newContracts = existing.contracts + contracts;
      const newAvg = (existing.entryPrice * existing.contracts + fillPrice * contracts) / newContracts;
      existing.contracts = newContracts;
      existing.entryPrice = newAvg;
      existing.fees += fees;
      positionId = existing.id;
    } else {
      positionId = `pp-${Date.now()}`;
      const pos: PaperPosition = {
        id: positionId,
        thesisId: card.id,
        ticker: card.ticker,
        title: card.title,
        side: card.side,
        contracts,
        entryPrice: fillPrice,
        fees,
        openedAt: Date.now(),
        playbook: card.playbook,
        category: category ?? card.category,
      };
      this.portfolio.positions.push(pos);
    }

    this.portfolio.cash -= total;
    this.portfolio.trades.unshift({
      id: `pt-${Date.now()}`,
      positionId,
      type: 'open',
      ticker: card.ticker,
      side: card.side,
      contracts,
      price: fillPrice,
      fees,
      timestamp: Date.now(),
      expectedPrice: fillMeta?.expectedPrice,
      slippage: fillMeta?.slippage,
      implementationShortfall: fillMeta?.implementationShortfall,
      depthLevels: fillMeta?.depthLevels,
      mode: fillMeta?.mode ?? 'paper',
      playbook: card.playbook,
      profitCertificate: fillMeta?.profitCertificate,
    });
    return { ok: true, position: this.portfolio.positions.find((p) => p.id === positionId)! };
  }

  closePosition(
    positionId: string,
    exitPrice: number,
    contractsToClose?: number,
    fillMeta?: FillMetadata,
  ): { ok: boolean; error?: string; pnl?: number } {
    const idx = this.portfolio.positions.findIndex((p) => p.id === positionId);
    if (idx === -1) return { ok: false, error: 'position not found' };
    const pos = this.portfolio.positions[idx];
    const qty = contractsToClose ?? pos.contracts;
    if (qty < 1 || qty > pos.contracts) return { ok: false, error: 'invalid close quantity' };

    const exitFees = kalshiFeeForOrder(exitPrice, qty);
    const proceeds = exitPrice * qty - exitFees;
    const costBasis = pos.entryPrice * qty + (pos.fees * qty) / pos.contracts;
    const pnl = proceeds - costBasis;

    this.portfolio.cash += proceeds;
    this.portfolio.realizedPnl += pnl;
    this.portfolio.trades.unshift({
      id: `pt-${Date.now()}`,
      positionId: pos.id,
      type: 'close',
      ticker: pos.ticker,
      side: pos.side,
      contracts: qty,
      price: exitPrice,
      fees: exitFees,
      pnl,
      timestamp: Date.now(),
      expectedPrice: fillMeta?.expectedPrice,
      slippage: fillMeta?.slippage,
      implementationShortfall: fillMeta?.implementationShortfall,
      depthLevels: fillMeta?.depthLevels,
      mode: fillMeta?.mode ?? 'paper',
      playbook: pos.playbook,
      profitCertificate: fillMeta?.profitCertificate,
      autoCloseDecisionId: fillMeta?.autoCloseDecisionId,
      autoCloseReason: fillMeta?.autoCloseReason,
      autoCloseAction: fillMeta?.autoCloseAction,
    });

    if (qty === pos.contracts) {
      this.portfolio.positions.splice(idx, 1);
    } else {
      const feePortion = (pos.fees * qty) / pos.contracts;
      pos.fees -= feePortion;
      pos.contracts -= qty;
    }
    return { ok: true, pnl };
  }

  markToMarket(markPrices: Map<string, number>): { equity: number; unrealized: number; deployed: number } {
    return markToMarketPortfolio(this.portfolio.positions, markPrices, this.portfolio.cash);
  }

  reset(startingCash = 1000) {
    this.portfolio = {
      cash: startingCash,
      startingCash,
      positions: [],
      trades: [],
      realizedPnl: 0,
    };
  }
}
