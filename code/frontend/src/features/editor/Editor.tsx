import { useCallback, useEffect, useRef, useState } from "react";
import { APP_CLOSE_PROMPT } from "@/lib/constants";
import {
  ArrowLeft,
  FileCode2,
  FolderOpen,
  Search,
  Undo2,
  Redo2,
  Save,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Brand } from "@/components/Brand";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  api,
  recordPath,
  type DocumentState,
  type EditorScope,
  type NbtNode,
  type RecordCategory,
  dataLabels,
  isDataCategory,
} from "@/lib/api";
import NbtTree from "./NbtTree";
import TagDialog from "./TagDialog";
import RecordDialog, { recordPrefixes } from "./RecordDialog";
import { RecordMenuContext } from "./RecordMenuContext";
import type { TagAction, TagInput } from "./tag-types";
import WorldTree from "./WorldTree";
import ScopeView from "./ScopeView";
import DataView from "./DataView";
import ScopeContextMenu, {
  deleteLabel,
  deleteDescription,
  type ScopeDelete,
} from "./ScopeContextMenu";
import { finishDesktopClose } from "@/lib/desktop";
import { matchesShortcut, shortcutHint } from "@/lib/preferences";
import { Settings2 } from "lucide-react";

export default function Editor({
  initial,
  onClose,
  windowCloseRequested,
  onCancelWindowClose,
  onSettings,
}: {
  initial: DocumentState;
  onClose: () => void;
  windowCloseRequested: boolean;
  onCancelWindowClose: () => void;
  onSettings?: () => void;
}) {
  const [doc, setDoc] = useState(initial);
  const [scope, setScope] = useState<EditorScope>("world");
  let title = doc.root.name;
  let searchLabel = `搜索 ${doc.root.name} 名称或值…`;
  let badge = "level.dat";
  if (scope === "world") {
    title = doc.world.name;
    searchLabel = `搜索 ${doc.world.name} 全部内容…`;
    badge = "世界";
  } else if (scope === "players") {
    title = "players";
    searchLabel = "筛选玩家名称或 ID…";
    badge = "players";
  } else if (scope === "data") {
    title = "data";
    searchLabel = "筛选 data 记录名称或 ID…";
    badge = "data";
  } else if (isDataCategory(scope)) {
    title = dataLabels[scope];
    searchLabel = `筛选 ${title} 名称或 ID…`;
    badge = title;
  } else if (doc.record_kind === "players") {
    badge = "players";
  } else if (doc.record_kind !== "level") {
    badge = dataLabels[doc.record_kind];
  }
  const [selected, setSelected] = useState(initial.root);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState<"world" | "window" | null>(null);
  const [action, setAction] = useState<TagAction | null>(null);
  const [deletion, setDeletion] = useState<ScopeDelete | null>(null);
  const [creation, setCreation] = useState<RecordCategory | null>(null);
  const recordNameRef = useRef("");
  const updateRecordDraft = useCallback((name: string) => {
    recordNameRef.current = name;
  }, []);
  const [deleteError, setDeleteError] = useState("");
  const canUndo = scope === "record" ? doc.can_undo : doc.scope_can_undo;
  const canRedo = scope === "record" ? doc.can_redo : doc.scope_can_redo;
  const blocked = busy || !!action || !!deletion || !!creation;
  const [draftChanged, setDraftChanged] = useState(false);
  const draftRef = useRef<TagInput | null>(null);
  const unsaved = doc.world_dirty || draftChanged || !!creation;
  const updateDraft = useCallback((changed: boolean, input: TagInput) => {
    draftRef.current = input;
    setDraftChanged(changed);
  }, []);
  useEffect(() => {
    if (windowCloseRequested) setClosing("window");
  }, [windowCloseRequested]);
  useEffect(() => {
    document.documentElement.dataset.unsaved = String(unsaved);
    return () => {
      delete document.documentElement.dataset.unsaved;
    };
  }, [unsaved]);
  useEffect(() => {
    function warn(event: BeforeUnloadEvent) {
      if (unsaved && !window.bedrockDesktop?.allowClose) {
        event.preventDefault();
        event.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unsaved]);
  function beginAction(next: TagAction) {
    if (blocked || scope !== "record") return;
    if (
      next.kind === "add" &&
      !next.node.allowed_child_types.includes(next.tagId)
    )
      return;
    setSelected(next.node);
    setAction(next);
  }
  function selectScope(next: EditorScope) {
    if (blocked) return;
    setScope(next);
    setQuery("");
  }
  async function switchRecord(record: string, node?: NbtNode) {
    if (blocked) return;
    setBusy(true);
    try {
      const next = await api<DocumentState>(recordPath({ id: doc.id, record }));
      // A search result is re-read when entering its record, so stale nodes cannot be edited.
      const target = node
        ? await api<NbtNode>(recordPath(next, `/nodes/${node.id}`))
        : next.root;
      setDoc({ ...next, selected: target });
      setSelected(target);
      setScope("record");
      setQuery("");
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function beginCreate(category: RecordCategory) {
    if (blocked) return;
    recordNameRef.current = recordPrefixes[category];
    setCreation(category);
  }
  async function createRecord(name: string) {
    if (!creation) throw new Error("当前没有正在新增的记录");
    setBusy(true);
    try {
      const next = await api<DocumentState>(
        `/documents/${doc.id}/records`,
        "POST",
        {
          revision: doc.revision,
          category: creation,
          name,
        },
      );
      setDoc(next);
      setSelected(next.root);
      setScope("record");
      setQuery("");
      return next;
    } finally {
      setBusy(false);
    }
  }
  async function addRootTag(record: string, tagId: number, records?: string[]) {
    if (blocked) return;
    setBusy(true);
    try {
      const next = await api<DocumentState>(recordPath({ id: doc.id, record }));
      if (!next.root.allowed_child_types.includes(tagId)) return;
      setDoc(next);
      setSelected(next.root);
      if ((records?.length ?? 0) <= 1) {
        setScope("record");
        setQuery("");
      }
      setAction({ kind: "add", node: next.root, tagId, records });
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function beginDelete(target: ScopeDelete) {
    if (blocked) return;
    setDeleteError("");
    setDeletion(target);
  }
  async function confirmDelete() {
    if (!deletion || busy) return;
    setBusy(true);
    setDeleteError("");
    try {
      const next = await api<DocumentState>(
        `/documents/${doc.id}/${deletion.records ? "record-selection/delete" : "delete-scope"}`,
        "POST",
        {
          revision: doc.revision,
          target: deletion.target,
          player: deletion.player,
          record: deletion.record,
          records: deletion.records,
        },
      );
      setDoc(next);
      setSelected(next.root);
      if (deletion.records && scope !== "record") setScope(scope);
      else if (deletion.records && doc.record_kind === "players")
        setScope("players");
      else if (deletion.target === "world") setScope("world");
      else if (deletion.target === "level") setScope("record");
      else if (deletion.target === "player" || deletion.target === "players")
        setScope("players");
      else if (deletion.target === "record") {
        if (scope === "data" || isDataCategory(scope)) setScope(scope);
        else if (doc.record_kind !== "level" && doc.record_kind !== "players")
          setScope(doc.record_kind === "other" ? "data" : doc.record_kind);
        else setScope("data");
      } else setScope(deletion.target);
      setDeletion(null);
    } catch (error) {
      setDeleteError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(input: TagInput) {
    if (!action) throw new Error("当前没有正在编辑的标签");
    setBusy(true);
    try {
      const endpoint =
        action.kind === "clear"
          ? "clear"
          : action.kind === "add"
            ? "add"
            : action.kind === "delete"
              ? "delete"
              : "commands";
      const body =
        action.kind === "clear"
          ? { revision: doc.revision }
          : action.kind === "add"
            ? {
                parent_id: action.node.id,
                tag_id: action.tagId,
                name: action.node.tag_id === 10 ? input.name : null,
                value: [9, 10].includes(action.tagId) ? null : input.value,
                list_type: action.tagId === 9 ? input.listType : null,
                revision: doc.revision,
              }
            : action.kind === "delete"
              ? { node_id: action.node.id, revision: doc.revision }
              : {
                  node_id: action.node.id,
                  name: action.node.renameable ? input.name : null,
                  value: action.kind === "edit" ? input.value : null,
                  revision: doc.revision,
                };
      const batch = action.kind === "add" && (action.records?.length ?? 0) > 1;
      const next = await api<DocumentState>(
        batch
          ? `/documents/${doc.id}/record-selection/add`
          : `/documents/${doc.id}/${endpoint}`,
        "POST",
        batch && action.kind === "add"
          ? { ...body, records: action.records }
          : { ...body, record: doc.record },
      );
      setDoc(next);
      setSelected(next.selected ?? next.root);
      return next;
    } finally {
      setBusy(false);
    }
  }
  const save = useCallback(async () => {
    if (blocked || !doc.world_dirty) return;
    setBusy(true);
    try {
      const next = await api<DocumentState>(
        `/documents/${doc.id}/save`,
        "POST",
        { revision: doc.revision, record: doc.record },
      );
      setDoc(next);
    } catch (e) {
      toast.error((e as Error).message);
      // A world save spans two storage targets; recover actual saved/dirty states.
      const next = await api<DocumentState>(recordPath(doc)).catch(() => null);
      if (next) setDoc(next);
    } finally {
      setBusy(false);
    }
  }, [blocked, doc]);
  const travel = useCallback(
    async (step: "undo" | "redo") => {
      if (blocked || (step === "undo" ? !canUndo : !canRedo)) return;
      setBusy(true);
      try {
        const next = await api<DocumentState>(
          `/documents/${doc.id}/${scope === "record" ? step : `scope-${step}`}`,
          "POST",
          { revision: doc.revision, record: doc.record },
        );
        setDoc(next);
        setSelected(next.root);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setBusy(false);
      }
    },
    [blocked, canUndo, canRedo, doc, scope],
  );
  useEffect(() => {
    function shortcuts(event: KeyboardEvent) {
      if (matchesShortcut(event, "save")) {
        event.preventDefault();
        void save();
      } else if (
        (matchesShortcut(event, "undo") || matchesShortcut(event, "redo")) &&
        !(event.target instanceof HTMLInputElement) &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        const step = matchesShortcut(event, "redo") ? "redo" : "undo";
        event.preventDefault();
        void travel(step);
      }
    }
    window.addEventListener("keydown", shortcuts);
    return () => window.removeEventListener("keydown", shortcuts);
  }, [save, travel]);
  async function leave() {
    setBusy(true);
    try {
      await api(`/documents/${doc.id}`, "DELETE");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function cancelClose() {
    if (closing === "window") onCancelWindowClose();
    setClosing(null);
  }
  async function finishClosing(saveChanges: boolean) {
    if (busy || !closing) return;
    const destination = closing;
    setBusy(true);
    try {
      let current = doc;
      if (saveChanges && action && draftChanged && draftRef.current) {
        current = await mutate(draftRef.current);
        setAction(null);
        setDraftChanged(false);
        setBusy(true);
      }
      if (saveChanges && creation) {
        current = await createRecord(recordNameRef.current);
        setCreation(null);
        setBusy(true);
      }
      if (saveChanges && current.world_dirty) {
        current = await api<DocumentState>(
          `/documents/${doc.id}/save`,
          "POST",
          { revision: current.revision, record: current.record },
        );
        setDoc(current);
      }
      if (destination === "window")
        await finishDesktopClose(!saveChanges && unsaved);
      else {
        await api(`/documents/${doc.id}`, "DELETE");
        onClose();
      }
    } catch (error) {
      toast.error((error as Error).message);
      const next = await api<DocumentState>(recordPath(doc)).catch(() => null);
      if (next) setDoc(next);
    } finally {
      setBusy(false);
    }
  }
  return (
    <RecordMenuContext.Provider
      value={{
        documentId: doc.id,
        revision: doc.revision,
        onCreate: beginCreate,
        onAddTag: (record, tagId, records) =>
          void addRootTag(record, tagId, records),
      }}
    >
      <div className="editor-page">
        <header className="editor-header">
          <div className="editor-brand">
            <Button
              variant="ghost"
              aria-label="退出存档"
              onClick={() => (unsaved ? setClosing("world") : void leave())}
              disabled={blocked}
            >
              <ArrowLeft data-icon="inline-start" />
              退出存档
            </Button>
            <Brand compact />
          </div>
          <div className="editor-world-name">
            <span>{doc.world.name}</span>
            <Badge variant="secondary">{badge}</Badge>
            <Button
              variant="ghost"
              onClick={onSettings}
              disabled={blocked}
              aria-label="应用设置"
            >
              <Settings2 />
            </Button>
          </div>
        </header>
        <div className="editor-toolbar">
          <div className="toolbar-label">
            <FileCode2 />
            <span>{title}</span>
            {(scope === "record" ? doc.dirty : doc.world_dirty) ? (
              <span className="modified-indicator" title="尚未保存" />
            ) : null}
          </div>
          <div className="toolbar-actions">
            <Button
              variant="ghost"
              size="icon"
              aria-label="撤销"
              title={`撤销 ${shortcutHint("undo")}`}
              disabled={!canUndo || blocked}
              onClick={() => void travel("undo")}
            >
              <Undo2 data-icon="inline-start" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="重做"
              title={`重做 ${shortcutHint("redo")}`}
              disabled={!canRedo || blocked}
              onClick={() => void travel("redo")}
            >
              <Redo2 data-icon="inline-start" />
            </Button>
            <Separator orientation="vertical" className="toolbar-separator" />
            <Button
              size="sm"
              onClick={() => void save()}
              title={`保存存档 ${shortcutHint("save")}`}
              disabled={!doc.world_dirty || blocked}
            >
              <Save data-icon="inline-start" />
              {busy ? "处理中…" : "保存存档"}
            </Button>
          </div>
        </div>
        <div className="editor-body">
          <aside className="world-sidebar">
            <div className="panel-heading">
              <FolderOpen />
              <h2>世界文件</h2>
            </div>
            <WorldTree
              doc={doc}
              scope={scope}
              onScope={selectScope}
              disabled={blocked}
              onSwitch={(record) => void switchRecord(record)}
              onAction={beginAction}
              onDelete={beginDelete}
            />
          </aside>
          <main className="nbt-main">
            <div className="nbt-heading">
              <div className="nbt-heading-label">
                {scope !== "record" ? (
                  <ScopeContextMenu
                    target={{ target: scope, name: title }}
                    disabled={blocked}
                    onDelete={beginDelete}
                  >
                    <h1 title={title}>{title}</h1>
                  </ScopeContextMenu>
                ) : (
                  <h1 title={title}>{title}</h1>
                )}
              </div>
              <div className="tag-search">
                <Search />
                <Input
                  aria-label={searchLabel}
                  placeholder={searchLabel}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  maxLength={200}
                  disabled={blocked}
                />
                {query ? (
                  <button
                    aria-label="清空搜索"
                    onClick={() => setQuery("")}
                    disabled={blocked}
                  >
                    <X />
                  </button>
                ) : (
                  <kbd>搜索</kbd>
                )}
              </div>
            </div>
            {scope === "record" ? (
              <NbtTree
                key={`${doc.record}-${scope}`}
                doc={doc}
                selected={selected.id}
                query={query}
                onSelect={setSelected}
                onAction={beginAction}
                disabled={blocked}
                onDeleteSearch={() =>
                  beginDelete({
                    target: doc.record === "level.dat" ? "level" : "record",
                    name: title,
                    records: [doc.record],
                  })
                }
              />
            ) : scope === "data" || isDataCategory(scope) ? (
              <DataView
                key={scope}
                doc={doc}
                category={scope}
                query={query}
                disabled={blocked}
                onOpen={(record) => void switchRecord(record)}
                onDelete={beginDelete}
              />
            ) : (
              <ScopeView
                key={scope}
                doc={doc}
                scope={scope}
                query={query}
                disabled={blocked}
                onOpen={(record, node) => void switchRecord(record, node)}
                onScope={selectScope}
                onDelete={beginDelete}
              />
            )}
          </main>
        </div>
        {creation ? (
          <RecordDialog
            category={creation}
            disabled={busy}
            onClose={() => setCreation(null)}
            onSubmit={createRecord}
            onDraftChange={updateRecordDraft}
          />
        ) : null}
        {action ? (
          <TagDialog
            key={`${action.kind}-${action.node.id}`}
            action={action}
            documentId={doc.id}
            record={doc.record}
            onClose={() => {
              setAction(null);
              setDraftChanged(false);
            }}
            onSubmit={mutate}
            onDraftChange={updateDraft}
          />
        ) : null}
        <Dialog
          open={deletion !== null}
          onOpenChange={(open) => {
            if (!open && !busy) setDeletion(null);
          }}
        >
          <DialogContent
            showCloseButton={!busy}
            onEscapeKeyDown={(event) => {
              if (busy) event.preventDefault();
            }}
            onPointerDownOutside={(event) => event.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>
                {deletion
                  ? deleteLabel(
                      deletion.target,
                      deletion.records?.length,
                    ).replace("…", "")
                  : "删除"}
              </DialogTitle>
              <DialogDescription className="break-all">
                {deletion ? deleteDescription(deletion) : ""}
                确认后可撤销，保存存档时写入。
              </DialogDescription>
            </DialogHeader>
            {deleteError ? (
              <p className="field-error" role="alert">
                {deleteError}
              </p>
            ) : null}
            <DialogFooter>
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => setDeletion(null)}
              >
                取消
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => void confirmDelete()}
              >
                {busy ? "处理中…" : "删除"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Dialog
          open={closing !== null}
          onOpenChange={(open) => {
            if (!open && !busy) cancelClose();
          }}
        >
          <DialogContent
            showCloseButton={!busy}
            onEscapeKeyDown={(e) => {
              if (busy) e.preventDefault();
            }}
            onPointerDownOutside={(e) => e.preventDefault()}
          >
            <DialogHeader>
              <DialogTitle>
                {closing === "window" ? "关闭程序？" : "返回世界选择？"}
              </DialogTitle>
              <DialogDescription>
                {unsaved
                  ? "是否保存当前修改？"
                  : closing === "window"
                    ? APP_CLOSE_PROMPT
                    : "确定返回世界选择？"}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={cancelClose} disabled={busy}>
                取消
              </Button>
              <Button
                variant={unsaved ? "outline" : "default"}
                onClick={() => void finishClosing(false)}
                disabled={busy}
              >
                {unsaved ? "不保存" : "关闭"}
              </Button>
              {unsaved ? (
                <Button
                  onClick={() => void finishClosing(true)}
                  disabled={busy}
                >
                  {closing === "window" ? "保存并关闭" : "保存并返回"}
                </Button>
              ) : null}
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </RecordMenuContext.Provider>
  );
}
