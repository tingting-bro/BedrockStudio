export interface World {
  id: string;
  path: string;
  name: string;
  folder_name: string;
  mode: string;
  version: string;
  seed: string | null;
  last_played: string;
  level_dat_size: number;
  tag_count: number;
  icon_url: string | null;
  error: string | null;
}
export interface NbtNode {
  id: string;
  name: string;
  path: (string | number)[];
  path_label: string;
  type: string;
  tag_id: number;
  container: boolean;
  child_count: number;
  list_type: string | null;
  value: string | null;
  summary: string;
  editable: boolean;
  renameable: boolean;
  deletable: boolean;
  allowed_child_types: number[];
}
export interface DocumentState {
  id: string;
  world: World;
  root: NbtNode;
  revision: number;
  dirty: boolean;
  can_undo: boolean;
  can_redo: boolean;
  header_version: number;
  changes: string[];
  selected?: NbtNode;
  backup_path?: string | null;
  record: string;
  record_kind: "level" | "players" | DataCategory;
  world_dirty: boolean;
  chunk_pending?: number;
  object_pending?: number;
  scope_can_undo: boolean;
  scope_can_redo: boolean;
  records: { id: string; name: string; dirty: boolean }[];
}
export interface PlayerRecord {
  id: string;
  name: string;
}
export function recordPath(
  doc: Pick<DocumentState, "id" | "record">,
  path = "",
) {
  const separator = path.includes("?") ? "&" : "?";
  return `/documents/${doc.id}${path}${separator}record=${encodeURIComponent(doc.record)}`;
}
export const dataCategories = [
  "maps",
  "tickingareas",
  "structures",
  "portals",
] as const;
export const commonDataCategories = [...dataCategories, "scoreboard"] as const;
export type RecordCategory = "players" | (typeof dataCategories)[number];
export interface RecordCapabilities {
  categories: RecordCategory[];
  tag_types: number[];
}
export type DataCategory = (typeof commonDataCategories)[number] | "other";
export const dataLabels: Record<DataCategory, string> = {
  maps: "Maps",
  tickingareas: "Tickingareas",
  structures: "Structures",
  portals: "Portals",
  scoreboard: "scoreboard",
  other: "NBT",
};
export type EditorScope =
  "world" | "players" | "record" | "data" | DataCategory;
export function isDataCategory(scope: string): scope is DataCategory {
  return (
    scope === "other" ||
    (commonDataCategories as readonly string[]).includes(scope)
  );
}
export interface WorldSearchResult {
  items: { record: string; record_name: string; node: NbtNode }[];
  truncated: boolean;
  errors: string[];
}
export interface WorldList {
  items: World[];
  recent: World[];
  roots: string[];
  warnings: string[];
}
let bootstrap:
  | Promise<{
      token: string;
      desktop: boolean;
      resources?: { cpu_workers: number; display_mb: number };
    }>
  | undefined;
export function config() {
  return (bootstrap ??= fetch("/api/bootstrap").then(async (r) => {
    if (!r.ok) throw new Error("无法连接本地编辑服务");
    return r.json();
  }));
}
export async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const { token } = await config();
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      "X-Editor-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }));
    throw new Error(
      typeof error.detail === "string" ? error.detail : "数据格式无效",
    );
  }
  return response.json();
}
export async function apiImage(
  path: string,
  signal: AbortSignal,
): Promise<Blob> {
  const { token } = await config();
  const response = await fetch(`/api${path}`, {
    headers: { "X-Editor-Token": token },
    signal,
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: "地图预览失败" }));
    throw new Error(
      typeof error.detail === "string" ? error.detail : "地图预览失败",
    );
  }
  return response.blob();
}
export async function apiBlob(path: string, method = "GET", body?: unknown) {
  const { token } = await config();
  const response = await fetch(`/api${path}`, {
    method,
    headers: {
      "X-Editor-Token": token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }));
    throw new Error(
      typeof error.detail === "string" ? error.detail : "请求失败",
    );
  }
  return response.blob();
}
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const { token } = await config();
  const response = await fetch(`/api${path}`, {
    method: "POST",
    headers: { "X-Editor-Token": token },
    body: form,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: "请求失败" }));
    throw new Error(
      typeof error.detail === "string" ? error.detail : "请求失败",
    );
  }
  return response.json();
}
export function dateLabel(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
export function sizeLabel(size: number) {
  return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
}
