import { FLIGHT_SPEED, RENDER_DISTANCE } from "./constants";

export const shortcutDefinitions = [
  ["save", "保存存档", "通用", "Ctrl+KeyS"],
  ["undo", "撤销", "NBT 编辑器", "Ctrl+KeyZ"],
  ["redo", "重做", "NBT 编辑器", "Ctrl+Shift+KeyZ"],
  ["delete", "删除选取", "区块编辑器", "Delete"],
  ["toggleView", "切换 2D / 3D", "区块编辑器", "Tab"],
  ["focus", "聚焦选区", "区块编辑器", "Home"],
  ["tools", "显示 / 隐藏工具", "区块编辑器", "KeyN"],
  ["copy", "复制方块选区", "区块编辑器", "Ctrl+KeyC"],
  ["move", "剪切 / 移动方块选区", "区块编辑器", "Ctrl+KeyX"],
  ["paste", "粘贴方块", "区块编辑器", "Ctrl+KeyV"],
  ["deselect", "清空方块选区", "区块编辑器", "Ctrl+KeyD"],
] as const;
export type ShortcutAction = (typeof shortcutDefinitions)[number][0];
export interface Preferences {
  world_layout: "grid" | "list";
  show_covers: boolean;
  default_view: "2d" | "3d" | "map";
  default_render_distance: number;
  default_flight_speed: number;
  reduced_motion: boolean;
  shortcuts: Record<ShortcutAction, string>;
}
export function defaultPreferences(): Preferences {
  return {
    world_layout: "grid",
    show_covers: true,
    default_view: "2d",
    default_render_distance: RENDER_DISTANCE.default,
    default_flight_speed: FLIGHT_SPEED.default,
    reduced_motion: false,
    shortcuts: Object.fromEntries(
      shortcutDefinitions.map(([id, , , key]) => [id, key]),
    ) as Preferences["shortcuts"],
  };
}
let current = defaultPreferences();
let settingsOpen = false;
export const getPreferences = () => current;
export function applyPreferences(value: Preferences) {
  current = value;
}
export function setSettingsOpen(value: boolean) {
  settingsOpen = value;
}
export function shortcutBinding(
  event: Pick<
    KeyboardEvent,
    "code" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
  >,
) {
  const code =
    event.code ||
    (/^[a-z]$/i.test(event.key)
      ? `Key${event.key.toUpperCase()}`
      : /^[0-9]$/.test(event.key)
        ? `Digit${event.key}`
        : event.key);
  if (
    [
      "ControlLeft",
      "ControlRight",
      "AltLeft",
      "AltRight",
      "ShiftLeft",
      "ShiftRight",
      "MetaLeft",
      "MetaRight",
      "Control",
      "Alt",
      "Shift",
      "Meta",
    ].includes(code)
  )
    return null;
  return `${event.ctrlKey || event.metaKey ? "Ctrl+" : ""}${event.altKey ? "Alt+" : ""}${event.shiftKey ? "Shift+" : ""}${code}`;
}
export function shortcutLabel(binding: string) {
  return binding
    .replace(/Key([A-Z])/g, "$1")
    .replace(/Digit([0-9])/g, "$1")
    .replace("Delete", "Del");
}
export function shortcutHint(action: ShortcutAction) {
  return shortcutLabel(current.shortcuts[action]);
}
export function matchesShortcut(event: KeyboardEvent, action: ShortcutAction) {
  const target = event.target as HTMLElement | null;
  const typing =
    target?.isContentEditable ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "") ||
    !!target?.closest?.('[contenteditable="true"], [role="textbox"]');
  return (
    !settingsOpen &&
    !event.defaultPrevented &&
    !event.isComposing &&
    !event.repeat &&
    !(typing && !event.ctrlKey && !event.metaKey && !event.altKey) &&
    shortcutBinding(event) === current.shortcuts[action]
  );
}
export function shortcutError(
  shortcuts: Preferences["shortcuts"],
): string | null {
  const seen = new Set<string>();
  for (const [id, label] of shortcutDefinitions) {
    const binding = shortcuts[id];
    if (
      !/^(Ctrl\+)?(Alt\+)?(Shift\+)?(Key[A-Z]|Digit[0-9]|F[1-9]|F1[0-2]|Delete|Home|End|PageUp|PageDown|Tab)$/.test(
        binding,
      )
    )
      return `${label}：不支持此按键`;
    if (
      /^(Shift\+)?Key[WASDQERFG]$/.test(binding) ||
      ["F5", "F11", "F12"].includes(binding.split("+").at(-1)!) ||
      [
        "Alt+F4",
        "Ctrl+KeyW",
        "Ctrl+KeyQ",
        "Ctrl+KeyR",
        "Ctrl+KeyL",
        "Ctrl+KeyT",
        "Ctrl+KeyN",
        "Ctrl+KeyO",
        "Ctrl+KeyP",
        "KeyW",
        "KeyA",
        "KeyS",
        "KeyD",
        "KeyQ",
        "KeyE",
        "KeyR",
        "KeyF",
        "KeyG",
      ].includes(binding)
    )
      return `${label}：此按键已用于窗口、飞行或变换操作`;
    if (seen.has(binding))
      return `${label}：${shortcutLabel(binding)} 与其他操作重复`;
    seen.add(binding);
  }
  return null;
}
