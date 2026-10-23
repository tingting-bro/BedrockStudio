// One counter for concurrent requests and local decoding/meshing work.
let pending = 0;
const listeners = new Set<() => void>();
export const loadingSnapshot = () => pending > 0;
export function subscribeLoading(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function beginLoading() {
  pending++;
  listeners.forEach((listener) => listener());
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    pending--;
    listeners.forEach((listener) => listener());
  };
}
export function installLoadingTracking() {
  const original = window.fetch;
  window.fetch = async (...args) => {
    const finish = beginLoading();
    const signal = args[1]?.signal;
    const end = () => {
      signal?.removeEventListener("abort", end);
      finish();
    };
    signal?.addEventListener("abort", end, { once: true });
    try {
      const response = await original(...args);
      if (!response.body) end();
      // Keep the indicator until body decoding finishes, including large uploads/downloads.
      for (const name of [
        "json",
        "text",
        "blob",
        "arrayBuffer",
        "formData",
      ] as const) {
        const read = response[name].bind(response);
        Object.defineProperty(response, name, {
          value: async () => {
            try {
              return await read();
            } finally {
              end();
            }
          },
        });
      }
      return response;
    } catch (error) {
      end();
      throw error;
    }
  };
  return () => {
    window.fetch = original;
  };
}
