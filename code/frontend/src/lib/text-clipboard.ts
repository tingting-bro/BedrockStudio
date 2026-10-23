type TextField = HTMLInputElement | HTMLTextAreaElement;

export function replaceSelectedText(
  field: TextField,
  text: string,
  start = field.selectionStart,
  end = field.selectionEnd,
) {
  const low = start ?? 0,
    high = end ?? field.value.length;
  const next = field.value.slice(0, low) + text + field.value.slice(high);
  const prototype =
    field instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, next);
  try {
    field.setSelectionRange(low + text.length, low + text.length);
  } catch {
    /* Numeric fields expose no selection API. */
  }
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

/** Native WebView menus may be disabled; keep text editing available inside every dialog. */
export function installTextClipboard(onError: (message: string) => void) {
  let menu: HTMLDivElement | null = null;
  const close = () => {
    menu?.remove();
    menu = null;
  };
  const outside = (event: Event) => {
    if (!menu?.contains(event.target as Node)) close();
  };
  const context = (event: MouseEvent) => {
    const field = (event.target as Element).closest(
      "input, textarea",
    ) as TextField | null;
    if (
      !field ||
      field.disabled ||
      (field instanceof HTMLInputElement &&
        ![
          "",
          "text",
          "search",
          "number",
          "url",
          "tel",
          "email",
          "password",
        ].includes(field.type))
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    close();
    field.focus();
    const start = field.selectionStart,
      end = field.selectionEnd;
    const selected = field.value.slice(start ?? 0, end ?? field.value.length);
    menu = document.createElement("div");
    menu.className = "text-clipboard-menu";
    menu.setAttribute("role", "menu");
    const add = (
      label: string,
      disabled: boolean,
      action: () => void | Promise<void>,
    ) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = disabled;
      button.setAttribute("role", "menuitem");
      button.addEventListener("pointerdown", (e) => e.preventDefault());
      button.addEventListener("click", () => {
        close();
        field.focus();
        void Promise.resolve()
          .then(action)
          .catch(() => onError("无法访问系统剪贴板，请使用 Ctrl+C / Ctrl+V"));
      });
      menu!.append(button);
    };
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(selected);
      } catch {
        if (!document.execCommand("copy")) throw new Error("copy");
      }
    };
    add("复制　Ctrl+C", !selected, copy);
    add("剪切　Ctrl+X", !selected || field.readOnly, async () => {
      await copy();
      replaceSelectedText(field, "", start, end);
    });
    add("粘贴　Ctrl+V", field.readOnly, async () => {
      let text: string;
      try {
        text = await navigator.clipboard.readText();
      } catch {
        if (document.execCommand("paste")) return;
        throw new Error("paste");
      }
      if (field.isConnected && !field.disabled && !field.readOnly)
        replaceSelectedText(field, text, start, end);
    });
    add("全选　Ctrl+A", false, () => field.select());
    // Stay inside the active modal's pointer/focus boundary, including nested NBT dialogs.
    (field.closest('[role="dialog"]') ?? document.body).append(menu);
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(0, Math.min(event.clientX, window.innerWidth - rect.width)) - rect.left}px`;
    menu.style.top = `${Math.max(0, Math.min(event.clientY, window.innerHeight - rect.height)) - rect.top}px`;
  };
  const escape = (event: KeyboardEvent) => {
    if (menu && event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
    }
  };
  document.addEventListener("contextmenu", context, true);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", escape, true);
  window.addEventListener("blur", close);
  return () => {
    close();
    document.removeEventListener("contextmenu", context, true);
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", escape, true);
    window.removeEventListener("blur", close);
  };
}
