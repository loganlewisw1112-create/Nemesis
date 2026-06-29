export function createSingleFlight<T>(work: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | null = null;
  return () => {
    if (inFlight) return inFlight;
    inFlight = work().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}
