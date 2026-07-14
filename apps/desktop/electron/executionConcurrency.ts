export class ExecutionReservation {
  private readonly reservations = new Map<string, symbol>();

  tryAcquire(key: string): (() => void) | null {
    if (this.reservations.has(key)) return null;

    const token = Symbol(key);
    this.reservations.set(key, token);

    return () => {
      if (this.reservations.get(key) === token) {
        this.reservations.delete(key);
      }
    };
  }

  isReserved(key: string): boolean {
    return this.reservations.has(key);
  }
}

export function dedupeByExecutionKey<T>(items: T[], keyFor: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyFor(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
