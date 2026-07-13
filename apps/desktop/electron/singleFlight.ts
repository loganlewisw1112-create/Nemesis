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

export async function withAbortTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  try {
    return await work(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}
