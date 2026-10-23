import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, FileCode2, LoaderCircle, FolderOpen } from "lucide-react";
import {
  api,
  commonDataCategories,
  dataLabels,
  type DocumentState,
  type NbtNode,
  type PlayerRecord,
  type WorldSearchResult,
  type EditorScope,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useRecordSelection } from "./useRecordSelection";
import SelectionBar from "./SelectionBar";
import { dataIcons } from "./data-icons";
import { Button } from "@/components/ui/button";
import MinecraftIcon from "@/components/MinecraftIcon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

import ScopeContextMenu, { type ScopeDelete } from "./ScopeContextMenu";

type Row = { id: string; name: string; detail?: string; node?: NbtNode };
export default function ScopeView({
  doc,
  scope,
  query,
  disabled,
  onOpen,
  onScope,
  onDelete,
}: {
  doc: DocumentState;
  scope: "world" | "players";
  query: string;
  disabled: boolean;
  onOpen: (record: string, node?: NbtNode) => void;
  onScope: (scope: EditorScope) => void;
  onDelete: (target: ScopeDelete) => void;
}) {
  const [rows, setRows] = useState<Row[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const parent = useRef<HTMLDivElement>(null);
  const term = query.trim();
  const selection = useRecordSelection(
    rows,
    `${doc.id}:${scope}:${term}:${doc.revision}`,
    scope === "players"
      ? async (signal) => {
          const result = await api<{ ids: string[] }>(
            `/documents/${doc.id}/record-selection/ids?scope=players&q=${encodeURIComponent(term)}&revision=${doc.revision}`,
            "GET",
            undefined,
            signal,
          );
          return result.ids;
        }
      : undefined,
  );
  useEffect(() => {
    setPage(0);
  }, [term, scope]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setErrors([]);
    setTruncated(false);
    if (scope !== "players" && !term) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      async () => {
        try {
          if (scope === "players") {
            const result = await api<{ items: PlayerRecord[]; total: number }>(
              `/documents/${doc.id}/players?q=${encodeURIComponent(term)}&offset=${page * 200}&limit=200`,
              "GET",
              undefined,
              controller.signal,
            );
            if (active) {
              if (page > 0 && page * 200 >= result.total) {
                setPage(Math.max(0, Math.ceil(result.total / 200) - 1));
                return;
              }
              setRows(result.items);
              setTotal(result.total);
            }
          } else {
            const result = await api<WorldSearchResult>(
              `/documents/${doc.id}/world-search?q=${encodeURIComponent(term)}&scope=${scope}`,
              "GET",
              undefined,
              controller.signal,
            );
            if (active) {
              setRows(
                result.items.map((item) => ({
                  id: item.record,
                  name: item.node.name || "（空名称）",
                  detail: `${item.record_name} / ${item.node.path_label} · ${item.node.summary}`,
                  node: item.node,
                })),
              );
              setTotal(result.items.length);
              setTruncated(result.truncated);
              setErrors(result.errors);
            }
          }
        } catch (error) {
          if (active) {
            setRows([]);
            setTotal(0);
            setErrors([(error as Error).message]);
          }
        } finally {
          if (active) setLoading(false);
        }
      },
      term ? 220 : 0,
    );
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [doc.id, doc.revision, scope, term, page, attempt]);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 56,
    overscan: 8,
    getItemKey: (index) => `${rows[index].id}:${rows[index].node?.id ?? ""}`,
  });
  useLayoutEffect(() => {
    if (parent.current) parent.current.scrollTop = 0;
  }, [term, page]);
  if (scope === "world" && !term)
    return (
      <section className="tree-panel">
        <ScopeContextMenu
          target={{ target: "level", name: "level.dat" }}
          disabled={disabled}
          onDelete={onDelete}
        >
          <Button
            variant="ghost"
            className="scope-entry"
            disabled={disabled}
            onClick={() => onOpen("level.dat")}
          >
            <FileCode2 data-icon="inline-start" />
            level.dat
          </Button>
        </ScopeContextMenu>
        <ScopeContextMenu
          target={{ target: "players", name: "players" }}
          disabled={disabled}
          onDelete={onDelete}
        >
          <Button
            variant="ghost"
            className="scope-entry"
            disabled={disabled}
            onClick={() => onScope("players")}
          >
            <MinecraftIcon name="player" data-icon="inline-start" />
            players
          </Button>
        </ScopeContextMenu>
        {commonDataCategories.map((category) => {
          const Icon = dataIcons[category];
          return (
            <ScopeContextMenu
              key={category}
              target={{ target: category, name: dataLabels[category] }}
              disabled={disabled}
              onDelete={onDelete}
            >
              <Button
                variant="ghost"
                className="scope-entry"
                disabled={disabled}
                onClick={() => onScope(category)}
              >
                <Icon data-icon="inline-start" />
                {dataLabels[category]}
              </Button>
            </ScopeContextMenu>
          );
        })}
        <ScopeContextMenu
          target={{ target: "data", name: "data" }}
          disabled={disabled}
          onDelete={onDelete}
        >
          <Button
            variant="ghost"
            className="scope-entry"
            disabled={disabled}
            onClick={() => onScope("data")}
          >
            <FolderOpen data-icon="inline-start" />
            data
          </Button>
        </ScopeContextMenu>
      </section>
    );
  return (
    <section
      className="tree-panel"
      onKeyDown={(event) => {
        if (
          event.key === "Delete" &&
          !disabled &&
          !loading &&
          selection.ids.size
        ) {
          event.preventDefault();
          onDelete({
            target: "record",
            name: "搜索所选记录",
            records: [...selection.ids],
          });
        } else
          selection.keyDown(event, disabled || loading || selection.allBusy);
      }}
      aria-label={scope === "players" ? "玩家列表" : "世界搜索结果"}
    >
      <SelectionBar
        count={selection.ids.size}
        disabled={disabled || loading}
        busy={selection.allBusy}
        error={selection.error}
        onAll={() => void selection.all()}
        onClear={selection.clear}
        onDelete={() =>
          onDelete({
            target: scope === "players" ? "player" : "record",
            name: "所选记录",
            records: [...selection.ids],
          })
        }
      />
      {errors.length ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>
            {errors.join("；")}{" "}
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAttempt((value) => value + 1)}
              disabled={disabled || loading}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div className="tree-search-progress" role="status">
          <LoaderCircle className="spin" />
          正在查找…
        </div>
      ) : null}
      {!loading && rows.length === 0 && !errors.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {scope === "players"
                ? term
                  ? "没有匹配的玩家"
                  : "没有玩家记录"
                : "没有找到标签"}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      <div
        className="tree-scroll"
        ref={parent}
        aria-busy={loading}
        role="listbox"
        aria-label={scope === "players" ? "玩家记录" : undefined}
        aria-multiselectable
      >
        <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const row = rows[item.index];
            const element = (
              <button
                key={item.key}
                className={cn(
                  "scope-list-row",
                  selection.ids.has(row.id) && "selected",
                )}
                role="option"
                aria-selected={selection.ids.has(row.id)}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: item.size,
                  transform: `translateY(${item.start}px)`,
                }}
                disabled={disabled || loading}
                title={row.detail ?? row.name}
                onClick={(event) => {
                  selection.click(row.id, event);
                }}
                onDoubleClick={(event) => {
                  if (!event.ctrlKey && !event.metaKey && !event.shiftKey)
                    onOpen(row.id, row.node);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    onOpen(row.id, row.node);
                  }
                }}
              >
                {scope === "players" ? (
                  <MinecraftIcon name="player" />
                ) : (
                  <FileCode2 />
                )}
                <span className="scope-row-text">
                  <strong className="truncate">{row.name}</strong>
                  {row.detail ? (
                    <span className="truncate">{row.detail}</span>
                  ) : null}
                </span>
                {doc.records.some(
                  (record) => record.id === row.id && record.dirty,
                ) ? (
                  <span className="modified-indicator" />
                ) : null}
              </button>
            );
            return scope === "players" ? (
              <ScopeContextMenu
                key={item.key}
                target={{
                  target: "player",
                  player: row.id,
                  name: row.name,
                  records: selection.targets(row.id),
                }}
                onPrepare={() => selection.context(row.id)}
                disabled={disabled || loading}
                onDelete={onDelete}
              >
                {element}
              </ScopeContextMenu>
            ) : (
              element
            );
          })}
        </div>
      </div>
      {!loading ? (
        <div className="scope-list-footer">
          <span>
            {total} {scope === "players" ? "个玩家" : "个搜索结果"}
            {truncated ? " · 已达到搜索上限" : ""}
            {selection.ids.size > 0 ? ` · 已选 ${selection.ids.size}` : ""}
          </span>
          {scope === "players" && total > 200 ? (
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || page === 0}
                onClick={() => setPage(page - 1)}
              >
                上一页
              </Button>
              <span>
                {page + 1} / {Math.ceil(total / 200)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || (page + 1) * 200 >= total}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
