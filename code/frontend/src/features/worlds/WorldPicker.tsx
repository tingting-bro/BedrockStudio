import { Fragment, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  FolderOpen,
  RefreshCw,
  Clock3,
  Search,
  AlertCircle,
  X,
  Settings2,
  LayoutGrid,
  History,
} from "lucide-react";
import { toast } from "sonner";
import {
  api,
  config,
  dateLabel,
  type DocumentState,
  type World,
  type WorldList,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Brand } from "@/components/Brand";
import PixelIcon from "@/components/PixelIcon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { defaultPreferences, type Preferences } from "@/lib/preferences";
import { APP_NAME, APP_DESCRIPTION, APP_VERSION_LABEL } from "@/lib/constants";

export function WorldCover({ world }: { world: World }) {
  const [failed, setFailed] = useState(false);
  return world.icon_url && !failed ? (
    <img
      className="world-cover"
      src={world.icon_url}
      alt={`${world.name} 的存档封面`}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
    />
  ) : (
    <div className="world-cover fallback-cover">
      <PixelIcon />
      <span>暂无世界封面</span>
    </div>
  );
}

export default function WorldPicker({
  onOpen,
  onSettings,
  preferences = defaultPreferences(),
}: {
  onOpen: (doc: DocumentState) => void;
  onSettings?: () => void;
  preferences?: Preferences;
}) {
  const [data, setData] = useState<WorldList>({
    items: [],
    recent: [],
    roots: [],
    warnings: [],
  });
  const [selected, setSelected] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(false);
  const [path, setPath] = useState("");
  const [pathError, setPathError] = useState("");
  const [category, setCategory] = useState<"all" | "recent">("all");
  const [sort, setSort] = useState<"recent" | "name" | "played">("recent");
  function refresh() {
    setLoading(true);
    setError("");
    api<WorldList>("/worlds")
      .then((result) => {
        setData(result);
        setSelected(null);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }
  useEffect(() => {
    let active = true;
    api<WorldList>("/worlds")
      .then((result) => {
        if (active) setData(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  const chosen = [...data.recent, ...data.items].find((w) => w.id === selected);
  const recentIds = new Set(data.recent.map((world) => world.id));
  const filtered = [
    ...data.recent,
    ...data.items.filter((world) => !recentIds.has(world.id)),
  ].filter(
    (w) =>
      (category !== "recent" || recentIds.has(w.id)) &&
      `${w.name} ${w.folder_name}`.toLowerCase().includes(query.toLowerCase()),
  );
  if (sort === "name")
    filtered.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  if (sort === "played")
    filtered.sort(
      (a, b) =>
        (Date.parse(b.last_played) || 0) - (Date.parse(a.last_played) || 0),
    );
  function insert(world: World) {
    setData((old) => ({
      ...old,
      recent: old.recent.map((item) => (item.id === world.id ? world : item)),
      items: [world, ...old.items.filter((w) => w.id !== world.id)],
    }));
    setSelected(world.id);
    setQuery("");
    setDialog(false);
    toast.success("已选择其他存档");
  }
  async function browse() {
    setBusy(true);
    try {
      const result = await api<{ world: World | null }>("/worlds/pick", "POST");
      if (result.world) insert(result.world);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function other() {
    if ((await config()).desktop) await browse();
    else {
      setPath("");
      setPathError("");
      setDialog(true);
    }
  }
  async function inspect() {
    setBusy(true);
    setPathError("");
    try {
      insert(await api<World>("/worlds/inspect", "POST", { path }));
    } catch (e) {
      setPathError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open() {
    if (!chosen) return;
    setBusy(true);
    try {
      onOpen(
        await api<DocumentState>("/documents/open", "POST", {
          path: chosen.path,
        }),
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="picker-page">
      <header className="picker-header">
        <Brand />
        <div className="page-header-actions">
          <span className="version-label">{APP_VERSION_LABEL}</span>
          <Button variant="ghost" onClick={onSettings}>
            <Settings2 /> 设置
          </Button>
        </div>
      </header>
      <div className="picker-workspace">
        <aside className="picker-sidebar" aria-label="存档导航">
          <div className="workspace-label">工作台</div>
          <button
            className={category === "all" ? "active" : ""}
            onClick={() => {
              setCategory("all");
              setSelected(null);
            }}
          >
            <LayoutGrid /> 全部存档{" "}
            <span>
              {new Set([...data.recent, ...data.items].map((w) => w.id)).size}
            </span>
          </button>
          <button
            className={category === "recent" ? "active" : ""}
            onClick={() => {
              setCategory("recent");
              setSelected(null);
            }}
          >
            <History /> 最近打开 <span>{data.recent.length}</span>
          </button>
          <div className="workspace-label">偏好</div>
          <button onClick={onSettings}>
            <Settings2 /> 应用设置
          </button>
          <details className="world-directories">
            <summary>
              <FolderOpen /> 存档目录 <span>{data.roots.length}</span>
            </summary>
            {data.roots.length ? (
              data.roots.map((root) => (
                <p key={root} title={root}>
                  {root}
                </p>
              ))
            ) : (
              <p>未找到默认目录，可手动选择其他存档。</p>
            )}
          </details>
          <div className="picker-sidebar-bottom">
            <PixelIcon />
            <span>
              {APP_NAME}
              <small>{APP_DESCRIPTION}</small>
            </span>
          </div>
        </aside>
        <main className="picker-main">
          <div className="picker-heading">
            <div>
              <span className="workspace-label">你的世界 · 你的创作</span>
              <h1>{category === "recent" ? "继续上次的创作" : "世界存档"}</h1>
              <p>选择一个世界，开始探索与编辑。</p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新存档列表"
              onClick={refresh}
              disabled={loading || busy}
            >
              <RefreshCw
                data-icon="inline-start"
                className={loading ? "spin" : ""}
              />
            </Button>
          </div>
          <div className="world-list-heading">
            <span>
              {category === "recent" ? "最近打开" : "全部存档"}{" "}
              <span className="world-count">
                {new Set([...data.recent, ...data.items].map((w) => w.id)).size}
              </span>
            </span>
            <select
              aria-label="存档排序"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              <option value="recent">最近打开优先</option>
              <option value="played">最近游玩优先</option>
              <option value="name">按名称排序</option>
            </select>
            <div className="world-search">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索世界"
                placeholder="搜索世界名称…"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                }}
              />
              {query ? (
                <button
                  className="clear-search"
                  aria-label="清空世界搜索"
                  onClick={() => setQuery("")}
                >
                  <X />
                </button>
              ) : null}
            </div>
          </div>
          {error ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {data.warnings.length ? (
            <Alert>
              <AlertCircle />
              <AlertDescription>{data.warnings.join("；")}</AlertDescription>
            </Alert>
          ) : null}
          {loading ? (
            <div className="world-grid">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="loading-card" />
              ))}
            </div>
          ) : filtered.length ? (
            <div
              className={cn(
                "world-grid",
                preferences.world_layout === "list" && "world-list",
                !preferences.show_covers && "world-no-covers",
              )}
              role="radiogroup"
              aria-label="世界存档"
            >
              {filtered.map((world, index) => (
                <Fragment key={world.id}>
                  {sort === "recent" &&
                  index === 0 &&
                  recentIds.has(world.id) ? (
                    <h2 className="world-section-title">最近打开的存档</h2>
                  ) : null}
                  {sort === "recent" &&
                  !recentIds.has(world.id) &&
                  (index === 0 || recentIds.has(filtered[index - 1].id)) ? (
                    <h2 className="world-section-title">本地世界</h2>
                  ) : null}
                  <label
                    key={world.id}
                    className={cn(
                      "world-card",
                      selected === world.id && "selected",
                      world.error && "invalid",
                    )}
                  >
                    <input
                      type="radio"
                      name="world"
                      className="sr-only"
                      aria-label={world.name + " · " + world.folder_name}
                      checked={selected === world.id}
                      onChange={() => setSelected(world.id)}
                      disabled={!!world.error || busy}
                    />
                    <div className="world-image">
                      {preferences.show_covers ? (
                        <WorldCover world={world} />
                      ) : (
                        <PixelIcon />
                      )}
                      {selected === world.id ? (
                        <span className="selected-check">
                          <Check />
                        </span>
                      ) : null}
                    </div>
                    <div className="world-card-body">
                      <h2 title={world.name}>{world.name}</h2>
                      {recentIds.has(world.id) ? (
                        <Badge variant="secondary">最近打开</Badge>
                      ) : null}
                      <div className="world-card-meta">
                        <span>{world.mode}</span>
                        <span>v{world.version}</span>
                      </div>
                      <div className="world-date">
                        <Clock3 aria-hidden="true" />
                        <span>{dateLabel(world.last_played)}</span>
                      </div>
                      <p className="folder-id" title={world.path}>
                        {world.folder_name}
                      </p>
                      {world.error ? (
                        <p className="card-error">{world.error}</p>
                      ) : null}
                    </div>
                  </label>
                </Fragment>
              ))}
            </div>
          ) : (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <PixelIcon />
                </EmptyMedia>
                <EmptyTitle>
                  {query ? "没有匹配的世界" : "还没有找到世界"}
                </EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "试试其他名称，或清空搜索。"
                    : "点击底部「其他存档」，选择包含 level.dat 的文件夹。"}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
      <footer className="picker-footer">
        <div className="picker-footer-inner">
          <div className="selection-status">
            <span className={cn("status-dot", chosen && "active")} />
            <div>
              {chosen ? (
                <>
                  <strong>{chosen.name}</strong>
                  <span>已选择世界 · 准备选择编辑模式</span>
                </>
              ) : (
                <>
                  <strong>尚未选择世界</strong>
                  <span>选择一张存档卡片以继续</span>
                </>
              )}
            </div>
          </div>
          <div className="picker-actions">
            <Button
              variant="outline"
              onClick={() => void other().catch((e) => toast.error(e.message))}
              disabled={busy}
            >
              <FolderOpen data-icon="inline-start" />
              其他存档
            </Button>
            <Button onClick={open} disabled={!chosen || busy || loading}>
              {busy ? "正在打开…" : "打开存档"}
              <ArrowRight data-icon="inline-end" />
            </Button>
          </div>
        </div>
      </footer>
      <Dialog open={dialog} onOpenChange={setDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>选择其他存档</DialogTitle>
            <DialogDescription>
              选择任意包含 level.dat 的世界文件夹，或输入完整路径。
            </DialogDescription>
          </DialogHeader>
          <Field data-invalid={!!pathError}>
            <FieldLabel htmlFor="world-path">世界文件夹</FieldLabel>
            <Input
              id="world-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\\…\\minecraftWorlds\\世界文件夹"
              aria-invalid={!!pathError}
              onKeyDown={(e) => {
                if (e.key === "Enter" && path.trim()) void inspect();
              }}
            />
            {pathError ? <p className="field-error">{pathError}</p> : null}
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={browse} disabled={busy}>
              <FolderOpen data-icon="inline-start" />
              选择文件夹
            </Button>
            <Button onClick={inspect} disabled={!path.trim() || busy}>
              选择此存档
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
