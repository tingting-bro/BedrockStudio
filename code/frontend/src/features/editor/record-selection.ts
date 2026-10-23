export type RecordSelection = { ids: Set<string>; anchor: string | null };
export type SelectionModifiers = {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
};

export function selectRecord(
  previous: RecordSelection,
  id: string,
  visible: string[],
  modifiers: SelectionModifiers,
): RecordSelection {
  const additive = modifiers.ctrlKey || modifiers.metaKey;
  if (modifiers.shiftKey && previous.anchor) {
    const start = visible.indexOf(previous.anchor);
    const end = visible.indexOf(id);
    if (start >= 0 && end >= 0) {
      const ids = new Set(additive ? previous.ids : []);
      for (const key of visible.slice(
        Math.min(start, end),
        Math.max(start, end) + 1,
      ))
        ids.add(key);
      return { ids, anchor: previous.anchor };
    }
  }
  const ids = new Set(additive ? previous.ids : []);
  if (additive && ids.has(id)) ids.delete(id);
  else ids.add(id);
  return { ids, anchor: id };
}

export function contextSelection(
  previous: RecordSelection,
  id: string,
): RecordSelection {
  return previous.ids.has(id) ? previous : { ids: new Set([id]), anchor: id };
}
