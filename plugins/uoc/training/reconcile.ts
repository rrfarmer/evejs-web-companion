/** Re-read native state only; never dispatch a write from this loop. */
export async function reconcile<T>(
  read: () => Promise<T | null>,
  current: () => void,
  failure: string,
  delayMs = 1250,
): Promise<T> {
  for (let attempt = 0; attempt < 9; attempt++) {
    current();
    try {
      const result = await read();
      current();
      if (result !== null) return result;
    } catch {
      current();
    }
    if (attempt < 8) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      current();
    }
  }
  throw Error(failure);
}
/** This exact bridge response is generated before native dispatch. */
export function preDispatchRefusal(status: number, data: any): boolean {
  return status === 400 && data?.ok === false && data?.error === "INVALID_REQUEST";
}
