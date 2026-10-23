import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, Search, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { api, recordPath, type DocumentState, type NbtNode } from "@/lib/api";
import { cn } from "@/lib/utils";
import PixelIcon from "@/components/PixelIcon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import NodeContextMenu from "./NodeContextMenu";
import type { TagAction } from "./tag-types";
import { useRecordSelection } from "./useRecordSelection";
import SelectionBar from "./SelectionBar";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";

type Children = { items: NbtNode[]; total: number };
type Row = { node: NbtNode; depth: number; more?: boolean };
function pathId(path: (string | number)[]) {
  if (path.length === 0) return "root";
  const bytes = new TextEncoder().encode(JSON.stringify(path));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export function TypeBadge({ node }: { node: NbtNode }) {
  return (
    <Badge
      variant="secondary"
      className={cn("type-badge", `type-${node.tag_id}`)}
    >
      {node.type}
    </Badge>
  );
}

export default function NbtTree({
  doc,
  selected,
  query,
  onSelect,
  onAction,
  disabled,
  onDeleteSearch,
}: {
  doc: DocumentState;
  selected: string;
  query: string;
  onSelect: (node: NbtNode) => void;
  onAction: (action: TagAction) => void;
  disabled: boolean;
  onDeleteSearch?: () => void;
}) {
  const [view, setView] = useState<{
    revision: number;
    cache: Record<string, Children>;
  }>({ revision: -1, cache: {} });
  const cache = view.cache;
  const refreshing = view.revision !== doc.revision;
  const [expanded, setExpanded] = useState(new Set([doc.root.id]));
  const [pending, setPending] = useState(new Set<string>());
  const [matches, setMatches] = useState<NbtNode[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [searching, setSearching] = useState(false);
  const [matchesRevision, setMatchesRevision] = useState(-1);
  const searchSelection = useRecordSelection(
    matches ?? [],
    `${doc.id}:${doc.record}:${doc.revision}:${query}`,
  );
  const locked =
    disabled ||
    refreshing ||
    searching ||
    (matches !== null && matchesRevision !== doc.revision);
  const parent = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const loads = useRef(new Set<AbortController>());
  const expandedRef = useRef(expanded);
  const cacheRef = useRef(cache);
  const scrollOffset = useRef(0);
  const revealPending = useRef(!!doc.selected && doc.selected.id !== "root");
  expandedRef.current = expanded;
  cacheRef.current = cache;
  useEffect(() => {
    const current = ++generation.current;
    const controller = new AbortController();
    scrollOffset.current = parent.current?.scrollTop ?? 0;
    const opened = new Set(expandedRef.current);
    opened.add(doc.root.id);
    if (doc.selected) {
      for (
        let depth = doc.root.path.length + 1;
        depth < doc.selected.path.length;
        depth++
      ) {
        opened.add(pathId(doc.selected.path.slice(0, depth)));
      }
    }
    const previous = cacheRef.current;
    setPending(new Set(opened));
    async function refresh(id: string) {
      let targetCount = Math.max(300, (previous[id]?.items.length ?? 0) + 1);
      let focus: string | number | undefined;
      if (revealPending.current && doc.selected) {
        for (let depth = 0; depth < doc.selected.path.length; depth++) {
          if (pathId(doc.selected.path.slice(0, depth)) === id) {
            focus = doc.selected.path[depth];
            break;
          }
        }
      }
      // Reload the pages already visible, so editing a later page preserves its context.
      let items: NbtNode[] = [];
      let total = 0;
      do {
        const result = await api<Children>(
          recordPath(
            doc,
            `/nodes/${id}/children?offset=${items.length}&limit=${Math.min(1000, targetCount - items.length)}`,
          ),
          "GET",
          undefined,
          controller.signal,
        );
        if (generation.current !== current) return null;
        items = [...items, ...result.items];
        total = result.total;
        if (result.items.length === 0) break;
        // World-search matches may be beyond the first page of a branch.
        if (
          focus !== undefined &&
          !items.some((child) => child.path.at(-1) === focus)
        ) {
          targetCount = Math.max(targetCount, items.length + 1000);
        }
      } while (items.length < Math.min(targetCount, total));
      return { items, total };
    }
    const ids = [...opened];
    // Keep the rendered tree until every open branch has refreshed. Clearing it
    // first collapses the scroll range and the browser clamps scrollTop to zero.
    void Promise.allSettled(ids.map(refresh)).then((results) => {
      if (generation.current !== current) return;
      const next: Record<string, Children> = {};
      results.forEach((result, index) => {
        const id = ids[index];
        if (result.status === "fulfilled" && result.value)
          next[id] = result.value;
        else {
          opened.delete(id);
          if (id === doc.root.id && result.status === "rejected")
            toast.error(result.reason.message);
        }
      });
      if (!next[doc.root.id]) {
        setPending(new Set());
        return;
      }
      scrollOffset.current = parent.current?.scrollTop ?? scrollOffset.current;
      setView({ revision: doc.revision, cache: next });
      setExpanded(opened);
      setPending(new Set());
    });
    return () => {
      generation.current++;
      controller.abort();
      for (const load of loads.current) load.abort();
      loads.current.clear();
    };
  }, [doc.id, doc.record, doc.revision, doc.root.id]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    if (!query.trim()) {
      setMatches(null);
      setSearching(false);
      setTruncated(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api<{ items: NbtNode[]; truncated: boolean }>(
        recordPath(doc, `/search?q=${encodeURIComponent(query.trim())}`),
        "GET",
        undefined,
        controller.signal,
      )
        .then((r) => {
          if (active) {
            setMatches(
              r.items.filter((node) =>
                doc.root.path.every((part, index) => node.path[index] === part),
              ),
            );
            setMatchesRevision(doc.revision);
            setTruncated(r.truncated);
          }
        })
        .catch((e) => {
          if (active) toast.error(e.message);
        })
        .finally(() => {
          if (active) setSearching(false);
        });
    }, 220);
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [doc.id, doc.record, doc.revision, query]);
  async function load(node: NbtNode, more = false) {
    const current = generation.current;
    const controller = new AbortController();
    loads.current.add(controller);
    setPending((old) => new Set(old).add(node.id));
    try {
      const result = await api<Children>(
        recordPath(
          doc,
          `/nodes/${node.id}/children?offset=${more ? (cache[node.id]?.items.length ?? 0) : 0}`,
        ),
        "GET",
        undefined,
        controller.signal,
      );
      if (current === generation.current)
        setView((old) => ({
          ...old,
          cache: {
            ...old.cache,
            [node.id]: {
              ...result,
              items: more
                ? [...(old.cache[node.id]?.items ?? []), ...result.items]
                : result.items,
            },
          },
        }));
    } catch (e) {
      if (!controller.signal.aborted) toast.error((e as Error).message);
    } finally {
      loads.current.delete(controller);
      if (current === generation.current)
        setPending((old) => {
          const next = new Set(old);
          next.delete(node.id);
          return next;
        });
    }
  }
  function toggle(node: NbtNode) {
    setExpanded((old) => {
      const next = new Set(old);
      if (next.has(node.id)) next.delete(node.id);
      else next.add(node.id);
      return next;
    });
    if (!expanded.has(node.id) && !cache[node.id] && !pending.has(node.id))
      void load(node);
  }
  const rows = useMemo<Row[]>(() => {
    if (matches !== null) return matches.map((node) => ({ node, depth: 0 }));
    const result: Row[] = [];
    function visit(node: NbtNode, depth: number) {
      result.push({ node, depth });
      if (expanded.has(node.id)) {
        const children = cache[node.id];
        children?.items.forEach((child) => visit(child, depth + 1));
        if (children && children.items.length < children.total)
          result.push({ node, depth: depth + 1, more: true });
      }
    }
    visit(doc.root, 0);
    return result;
  }, [cache, expanded, matches, doc.root]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 38,
    overscan: 10,
    getItemKey: (index) =>
      `${rows[index].node.id}${rows[index].more ? "-more" : ""}`,
  });
  useLayoutEffect(() => {
    if (!refreshing && parent.current) {
      parent.current.scrollTop = scrollOffset.current;
    }
  }, [view.revision, refreshing]);
  useLayoutEffect(() => {
    if (refreshing || !revealPending.current) return;
    const index = rows.findIndex(
      (row) => !row.more && row.node.id === selected,
    );
    if (index >= 0) {
      virtual.scrollToIndex(index, { align: "center" });
      revealPending.current = false;
    }
  }, [refreshing, rows, selected, virtual]);
  return (
    <section
      className="tree-panel"
      aria-label="NBT 数据树"
      onKeyDown={(event) => {
        if (!matches || !onDeleteSearch) return;
        if (event.key === "Delete" && searchSelection.ids.size && !locked) {
          event.preventDefault();
          event.stopPropagation();
          onDeleteSearch();
        } else searchSelection.keyDown(event, locked);
      }}
    >
      {matches && onDeleteSearch && (
        <SelectionBar
          count={searchSelection.ids.size}
          disabled={locked}
          onAll={() => void searchSelection.all()}
          onClear={searchSelection.clear}
          onDelete={onDeleteSearch}
        />
      )}
      <div className="tree-column-head">
        <span>名称</span>
        <span>类型</span>
        <span>值 / 内容</span>
      </div>
      {searching ? (
        <div className="tree-search-progress">
          <LoaderCircle className="spin" />
          正在查找…
        </div>
      ) : null}
      {matches?.length === 0 && !searching ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search />
            </EmptyMedia>
            <EmptyTitle>没有找到标签</EmptyTitle>
            <EmptyDescription>可以搜索标签名称、路径或值。</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div
          className="tree-scroll"
          ref={parent}
          role="tree"
          aria-label="NBT 标签"
          aria-busy={refreshing || pending.size > 0 || searching}
        >
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index];
              const node = row.node;
              return (
                <div
                  key={`${node.id}${row.more ? "more" : ""}`}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  {row.more ? (
                    <Button
                      className="load-more"
                      variant="ghost"
                      size="sm"
                      onClick={() => void load(node, true)}
                      disabled={pending.has(node.id) || locked}
                    >
                      加载更多（{cache[node.id].items.length} /{" "}
                      {cache[node.id].total}）
                    </Button>
                  ) : (
                    <NodeContextMenu
                      node={node}
                      disabled={locked}
                      onAction={onAction}
                      onSelect={onSelect}
                    >
                      <div
                        className={cn(
                          "tree-row",
                          (matches && onDeleteSearch
                            ? searchSelection.ids.has(node.id)
                            : selected === node.id) && "selected",
                        )}
                        role="treeitem"
                        aria-level={row.depth + 1}
                        aria-selected={
                          matches && onDeleteSearch
                            ? searchSelection.ids.has(node.id)
                            : selected === node.id
                        }
                        aria-expanded={
                          node.container ? expanded.has(node.id) : undefined
                        }
                        tabIndex={locked ? -1 : 0}
                        onClick={(event) => {
                          if (!locked) {
                            if (matches && onDeleteSearch)
                              searchSelection.click(node.id, event);
                            else onSelect(node);
                          }
                        }}
                        onDoubleClick={() => {
                          if (locked) return;
                          if (node.editable) onAction({ kind: "edit", node });
                          else if (node.container) toggle(node);
                        }}
                        onKeyDown={(e) => {
                          if (locked) return;
                          if (e.key === "F2" && node.renameable) {
                            e.preventDefault();
                            onAction({ kind: "rename", node });
                          }
                          if (e.key === "Delete" && matches && onDeleteSearch) {
                            e.preventDefault();
                            e.stopPropagation();
                            if (searchSelection.ids.size) onDeleteSearch();
                          } else if (e.key === "Delete" && node.deletable) {
                            e.preventDefault();
                            onAction({ kind: "delete", node });
                          }
                          if (e.key === "Enter") {
                            e.preventDefault();
                            onSelect(node);
                          }
                          if (
                            e.key === "ArrowRight" &&
                            node.container &&
                            !expanded.has(node.id)
                          ) {
                            e.preventDefault();
                            toggle(node);
                          }
                          if (e.key === "ArrowLeft" && expanded.has(node.id)) {
                            e.preventDefault();
                            toggle(node);
                          }
                        }}
                      >
                        <div
                          className="tree-node-name"
                          style={{ paddingLeft: 14 + row.depth * 20 }}
                        >
                          {node.container ? (
                            <button
                              aria-label={`${expanded.has(node.id) ? "折叠" : "展开"} ${node.name}`}
                              disabled={locked || pending.has(node.id)}
                              className="expand-node"
                              onClick={(e) => {
                                e.stopPropagation();
                                toggle(node);
                              }}
                            >
                              {pending.has(node.id) ? (
                                <LoaderCircle className="spin" />
                              ) : expanded.has(node.id) ? (
                                <ChevronDown />
                              ) : (
                                <ChevronRight />
                              )}
                            </button>
                          ) : (
                            <span className="node-spacer" />
                          )}
                          {node.container ? (
                            <PixelIcon
                              kind="folder"
                              className="node-kind container-kind"
                            />
                          ) : (
                            <PixelIcon kind="file" className="node-kind" />
                          )}
                          <span title={node.path_label}>
                            {typeof node.path.at(-1) === "number"
                              ? `[${node.name}]`
                              : node.name || "（空名称）"}
                          </span>
                        </div>
                        <span>
                          <TypeBadge node={node} />
                        </span>
                        <span
                          className="tree-value"
                          title={node.value ?? node.summary}
                        >
                          {node.summary}
                        </span>
                      </div>
                    </NodeContextMenu>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {matches !== null ? (
        <div className="tree-footer">
          {matches.length} 个搜索结果{truncated ? " · 已达到搜索上限" : ""}
        </div>
      ) : null}
    </section>
  );
}
