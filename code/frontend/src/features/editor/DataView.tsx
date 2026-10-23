import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, ImageOff, LoaderCircle } from "lucide-react";
import {
  api,
  apiImage,
  dataLabels,
  type DataCategory,
  type DocumentState,
  type PlayerRecord,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Empty, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import ScopeContextMenu, { type ScopeDelete } from "./ScopeContextMenu";
import { useRecordSelection } from "./useRecordSelection";
import type { SelectionModifiers } from "./record-selection";
import { dataIcons } from "./data-icons";
import SelectionBar from "./SelectionBar";

function MapCard({
  id,
  revision,
  row,
  selected,
  disabled,
  onSelect,
  onOpen,
}: {
  id: string;
  revision: number;
  row: PlayerRecord;
  selected: boolean;
  disabled: boolean;
  onSelect: (modifiers: SelectionModifiers) => void;
  onOpen: () => void;
}) {
  const [preview, setPreview] = useState<{
    url?: string;
    error?: string;
    key?: string;
  }>({});
  const [visible, setVisible] = useState(false);
  const previewElement = useRef<HTMLDivElement>(null);
  const previewUrl = useRef<string | undefined>(undefined);
  const previewKey = `${id}:${row.id}:${revision}`;
  useEffect(() => {
    const element = previewElement.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setVisible(entries.some((entry) => entry.isIntersecting));
      },
      { root: element.closest(".tree-scroll") },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setPreview({});
    return () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
      previewUrl.current = undefined;
    };
  }, [id, row.id, revision]);
  useEffect(() => {
    if (!visible || preview.key === previewKey) return;
    const controller = new AbortController();
    apiImage(
      `/documents/${id}/map-preview?record=${encodeURIComponent(row.id)}&revision=${revision}`,
      controller.signal,
    )
      .then((blob) => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        previewUrl.current = url;
        setPreview({ url, key: previewKey });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setPreview({ error: (error as Error).message, key: previewKey });
      });
    return () => {
      controller.abort();
    };
  }, [id, row.id, revision, visible, preview.key, previewKey]);
  return (
    <Card
      role="option"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={`打开 ${row.name} NBT`}
      aria-selected={selected}
      className={cn("map-card", selected && "selected")}
      onClick={(event) => {
        if (!disabled) onSelect(event);
      }}
      onDoubleClick={(event) => {
        if (!disabled && !event.ctrlKey && !event.metaKey && !event.shiftKey)
          onOpen();
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (event.key === "Enter") onOpen();
          else onSelect(event);
        }
      }}
    >
      <CardContent className="px-3">
        <div className="map-preview" title={preview.error} ref={previewElement}>
          {preview.url ? (
            <img
              src={preview.url}
              alt={`${row.name} 地图预览`}
              draggable={false}
            />
          ) : preview.error ? (
            <>
              <ImageOff />
              <span>暂无地图图像</span>
            </>
          ) : (
            <LoaderCircle className="spin" aria-label="正在读取地图" />
          )}
        </div>
      </CardContent>
      <CardHeader className="px-3">
        <CardTitle className="truncate" title={row.name}>
          {row.name}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}

export default function DataView({
  doc,
  category,
  query,
  disabled,
  onOpen,
  onDelete,
}: {
  doc: DocumentState;
  category: DataCategory | "data";
  query: string;
  disabled: boolean;
  onOpen: (record: string) => void;
  onDelete: (target: ScopeDelete) => void;
}) {
  const [rows, setRows] = useState<PlayerRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const parent = useRef<HTMLDivElement>(null);
  const term = query.trim();
  const selection = useRecordSelection(
    rows,
    `${doc.id}:${category}:${term}:${doc.revision}`,
    async (signal) => {
      const result = await api<{ ids: string[] }>(
        `/documents/${doc.id}/record-selection/ids?scope=${category}&q=${encodeURIComponent(term)}&revision=${doc.revision}`,
        "GET",
        undefined,
        signal,
      );
      return result.ids;
    },
  );
  const pageSize = category === "maps" ? 24 : 200;
  useEffect(() => {
    setPage(0);
  }, [term, category]);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    const timer = setTimeout(
      async () => {
        try {
          const result = await api<{ items: PlayerRecord[]; total: number }>(
            `/documents/${doc.id}/data/${category === "data" ? "other" : category}?q=${encodeURIComponent(term)}&offset=${page * pageSize}&limit=${pageSize}`,
            "GET",
            undefined,
            controller.signal,
          );
          if (!active) return;
          if (page > 0 && page * pageSize >= result.total) {
            setPage(Math.max(0, Math.ceil(result.total / pageSize) - 1));
            return;
          }
          setRows(result.items);
          setTotal(result.total);
        } catch (error) {
          if (active) {
            setError((error as Error).message);
            setRows([]);
            setTotal(0);
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
  }, [doc.id, doc.revision, category, term, page, pageSize, attempt]);
  const virtual = useVirtualizer({
    count: category === "maps" ? 0 : rows.length,
    getScrollElement: () => parent.current,
    estimateSize: () => 56,
    overscan: 8,
    getItemKey: (index) => rows[index].id,
  });
  useLayoutEffect(() => {
    if (parent.current) parent.current.scrollTop = 0;
  }, [term, page]);
  const Icon = category === "data" ? dataIcons.other : dataIcons[category];
  const label = category === "data" ? "data" : dataLabels[category];
  return (
    <section
      className="tree-panel"
      aria-label={`${label} 列表`}
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
            name: "所选记录",
            records: [...selection.ids],
          });
        } else
          selection.keyDown(event, disabled || loading || selection.allBusy);
      }}
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
            target: "record",
            name: "所选记录",
            records: [...selection.ids],
          })
        }
      />
      {error ? (
        <Alert variant="destructive">
          <AlertCircle />
          <AlertDescription>
            {error}
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || loading}
              onClick={() => setAttempt((value) => value + 1)}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div className="tree-search-progress" role="status">
          <LoaderCircle className="spin" />
          正在读取…
        </div>
      ) : null}
      {!loading && !rows.length && !error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>
              {term ? "没有匹配的记录" : `没有 ${label} 记录`}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      <div
        className="tree-scroll"
        ref={parent}
        aria-busy={loading}
        role="listbox"
        aria-label={`${label} 记录`}
        aria-multiselectable
      >
        {category === "maps" ? (
          <div className="map-grid">
            {rows.map((row) => (
              <ScopeContextMenu
                key={row.id}
                target={{
                  target: "record",
                  record: row.id,
                  name: row.name,
                  records: selection.targets(row.id),
                }}
                onPrepare={() => selection.context(row.id)}
                disabled={disabled || loading}
                onDelete={onDelete}
              >
                <div>
                  <MapCard
                    id={doc.id}
                    revision={doc.revision}
                    row={row}
                    selected={selection.ids.has(row.id)}
                    disabled={disabled || loading}
                    onSelect={(event) => selection.click(row.id, event)}
                    onOpen={() => onOpen(row.id)}
                  />
                </div>
              </ScopeContextMenu>
            ))}
          </div>
        ) : (
          <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <ScopeContextMenu
                  key={item.key}
                  target={{
                    target: "record",
                    record: row.id,
                    name: row.name,
                    records: selection.targets(row.id),
                  }}
                  onPrepare={() => selection.context(row.id)}
                  disabled={disabled || loading}
                  onDelete={onDelete}
                >
                  <button
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
                    title={row.name}
                    onClick={(event) => selection.click(row.id, event)}
                    onDoubleClick={(event) => {
                      if (!event.ctrlKey && !event.metaKey && !event.shiftKey)
                        onOpen(row.id);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        onOpen(row.id);
                      }
                    }}
                  >
                    <Icon />
                    <span className="scope-row-text">
                      <strong className="truncate">{row.name}</strong>
                    </span>
                    {doc.records.some(
                      (record) => record.id === row.id && record.dirty,
                    ) ? (
                      <span className="modified-indicator" />
                    ) : null}
                  </button>
                </ScopeContextMenu>
              );
            })}
          </div>
        )}
      </div>
      {!loading ? (
        <div className="scope-list-footer">
          <span>
            {total} 条记录
            {selection.ids.size > 0 ? ` · 已选 ${selection.ids.size}` : ""}
          </span>
          {total > pageSize ? (
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
                {page + 1} / {Math.ceil(total / pageSize)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={disabled || (page + 1) * pageSize >= total}
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
