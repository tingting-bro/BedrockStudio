import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  contextSelection,
  selectRecord,
  type RecordSelection,
  type SelectionModifiers,
} from "./record-selection";

export function useRecordSelection(
  rows: { id: string }[],
  key: string,
  loadAll?: (signal: AbortSignal) => Promise<string[]>,
) {
  const [state, setState] = useState<{
    key: string;
    selection: RecordSelection;
  }>(() => ({ key, selection: { ids: new Set(), anchor: null } }));
  const selection =
    state.key === key
      ? state.selection
      : { ids: new Set<string>(), anchor: null };
  if (state.key !== key) setState({ key, selection });
  const [allState, setAllState] = useState({ busy: false, error: "" });
  const request = useRef<AbortController | null>(null);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    setAllState({ busy: false, error: "" });
    return () => request.current?.abort();
  }, [key]);
  function update(change: (previous: RecordSelection) => RecordSelection) {
    setState((previous) => ({
      key,
      selection: change(
        previous.key === key
          ? previous.selection
          : { ids: new Set(), anchor: null },
      ),
    }));
  }
  async function all() {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAllState({ busy: true, error: "" });
    try {
      const ids = loadAll
        ? await loadAll(controller.signal)
        : rows.map((row) => row.id);
      if (!controller.signal.aborted && currentKey.current === key)
        update(() => ({ ids: new Set(ids), anchor: rows[0]?.id ?? null }));
    } catch (error) {
      if (!controller.signal.aborted && currentKey.current === key)
        setAllState({ busy: false, error: (error as Error).message });
    } finally {
      if (!controller.signal.aborted && currentKey.current === key)
        setAllState((previous) => ({ ...previous, busy: false }));
    }
  }
  return {
    ids: selection.ids,
    all,
    allBusy: allState.busy,
    error: allState.error,
    clear() {
      update(() => ({ ids: new Set(), anchor: null }));
    },
    click(id: string, modifiers: SelectionModifiers) {
      request.current?.abort();
      setAllState({ busy: false, error: "" });
      update((previous) =>
        selectRecord(
          previous,
          id,
          rows.map((row) => row.id),
          modifiers,
        ),
      );
    },
    context(id: string) {
      update((previous) => contextSelection(previous, id));
    },
    targets(id: string) {
      return selection.ids.has(id) ? Array.from(selection.ids) : [id];
    },
    keyDown(event: KeyboardEvent, disabled: boolean) {
      if (disabled || event.defaultPrevented) return;
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement
      )
        return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        void all();
      } else if (event.key === "Escape") {
        event.preventDefault();
        update(() => ({ ids: new Set(), anchor: null }));
      }
    },
  };
}
