import { ExecutionReservation } from './executionConcurrency.js';

export class PaperExecutionCoordinator {
  constructor(private readonly reservations = new ExecutionReservation()) {}

  async execute<T>(
    key: string,
    run: () => Promise<T>,
    inFlightResult: () => T,
  ): Promise<T> {
    const release = this.reservations.tryAcquire(key);
    if (!release) return inFlightResult();

    try {
      return await run();
    } finally {
      release();
    }
  }

  isReserved(key: string): boolean {
    return this.reservations.isReserved(key);
  }
}
