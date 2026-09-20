export async function waitForRegistryRefresh(
  refresh: (signal?: AbortSignal) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<"completed" | "aborted"> {
  if (signal?.aborted) return "aborted";
  if (!signal) {
    await refresh();
    return "completed";
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", abort);
    const finish = (result: "completed" | "aborted") => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const abort = () => finish("aborted");
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve()
      .then(() => refresh(signal))
      .then(() => finish("completed"), (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      });
  });
}
