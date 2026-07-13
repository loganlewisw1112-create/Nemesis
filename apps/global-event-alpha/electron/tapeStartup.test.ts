import { afterEach, describe, expect, it, vi } from 'vitest';
import { TapeStartupCoordinator } from './tapeStartup.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('TapeStartupCoordinator', () => {
  it('starts standalone GEA immediately', () => {
    const startTape = vi.fn();
    new TapeStartupCoordinator({ coordinated: false, fallbackMs: 30_000, startTape }).begin();
    expect(startTape).toHaveBeenCalledOnce();
  });

  it('waits for NEMESIS feed readiness and starts only once', () => {
    vi.useFakeTimers();
    const startTape = vi.fn();
    const coordinator = new TapeStartupCoordinator({
      coordinated: true,
      fallbackMs: 30_000,
      startTape,
    });
    coordinator.begin();
    expect(startTape).not.toHaveBeenCalled();

    coordinator.observeNemesisState({
      thesesCount: 0,
      marketsCount: 0,
      isLive: false,
      paperCash: 0,
      paperEquity: 0,
      dailyPnl: 0,
      gates: [],
      activeRegimes: [],
      marketFeedReady: true,
      timestamp: Date.now(),
    });
    vi.advanceTimersByTime(30_000);

    expect(startTape).toHaveBeenCalledOnce();
  });

  it('uses a bounded fallback if the readiness message never arrives', () => {
    vi.useFakeTimers();
    const startTape = vi.fn();
    const coordinator = new TapeStartupCoordinator({
      coordinated: true,
      fallbackMs: 30_000,
      startTape,
    });
    coordinator.begin();
    vi.advanceTimersByTime(29_999);
    expect(startTape).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(startTape).toHaveBeenCalledOnce();
  });
});
