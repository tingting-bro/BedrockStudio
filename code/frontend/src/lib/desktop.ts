declare global {
  interface Window {
    bedrockDesktop?: { requestClose: () => void; allowClose: boolean };
    pywebview?: {
      api: {
        confirm_close: (
          discard: boolean,
        ) => Promise<{ closed: boolean; error?: string }>;
        cancel_close: () => Promise<unknown>;
      };
    };
  }
}

export function cancelDesktopClose() {
  if (window.bedrockDesktop) window.bedrockDesktop.allowClose = false;
  void window.pywebview?.api.cancel_close();
}

export async function finishDesktopClose(discard = false) {
  const bridge = window.pywebview?.api;
  if (!bridge) throw new Error("桌面窗口连接不可用");
  if (window.bedrockDesktop) window.bedrockDesktop.allowClose = true;
  try {
    const result = await bridge.confirm_close(discard);
    if (!result.closed) throw new Error(result.error ?? "无法关闭窗口");
  } catch (error) {
    if (window.bedrockDesktop) window.bedrockDesktop.allowClose = false;
    throw error;
  }
}
