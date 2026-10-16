import { flagPacingParkAbortReason } from "./pacing-park";

const sleepWithSignal = (delayMs: number, signal?: AbortSignal | null): Promise<void> => {
  if (signal?.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onAbort = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      flagPacingParkAbortReason(signal?.reason);
      reject(signal?.reason);
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

export { sleepWithSignal };
