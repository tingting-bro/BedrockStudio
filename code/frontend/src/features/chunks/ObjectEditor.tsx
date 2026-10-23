import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import { RotateCcw, RotateCw, Trash2 } from "lucide-react";
import { api, recordPath, type DocumentState, type NbtNode } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import NbtTree from "../editor/NbtTree";
import TagDialog from "../editor/TagDialog";
import type { TagAction, TagInput } from "../editor/tag-types";

export interface ObjectEditorHandle {
  flush: () => Promise<DocumentState | undefined>;
}
interface ObjectState extends DocumentState {
  object_path: (string | number)[];
  object_mapped?: boolean;
  object_deletable?: boolean;
}

function pathId(path: (string | number)[]) {
  if (!path.length) return "root";
  return btoa(
    Array.from(new TextEncoder().encode(JSON.stringify(path)), (byte) =>
      String.fromCharCode(byte),
    ).join(""),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export default function ObjectEditor({
  id,
  revision,
  reference,
  label,
  onClose,
  onChanged,
  onDraftChange,
  ref,
}: {
  id: string;
  revision: number;
  reference: string;
  label: string;
  onClose: () => void;
  onChanged: (state: DocumentState) => void;
  onDraftChange: (dirty: boolean) => void;
  ref?: Ref<ObjectEditorHandle>;
}) {
  const [doc, setDoc] = useState<ObjectState | null>(null);
  const [selected, setSelected] = useState<NbtNode | null>(null);
  const [action, setAction] = useState<TagAction | null>(null);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [searchDeletion, setSearchDeletion] = useState(false);
  const draft = useRef<{ dirty: boolean; input: TagInput } | null>(null);
  const focus = useRef<NbtNode | null>(null);
  const openingRevision = useRef(revision);
  const draftChanged = useCallback(
    (dirty: boolean, input: TagInput) => {
      draft.current = { dirty, input };
      onDraftChange(dirty);
    },
    [onDraftChange],
  );

  async function focused(next: DocumentState, path: (string | number)[]) {
    const id = pathId(path);
    const root = await api<NbtNode>(recordPath(next, `/nodes/${id}`)).catch(
      (e) => {
        setError(e.message);
        return { ...(focus.current ?? next.root) };
      },
    );
    root.name = label;
    root.renameable = false;
    root.deletable = false;
    focus.current = root;
    const selected =
      next.selected &&
      path.every((part, index) => next.selected!.path[index] === part)
        ? next.selected
        : root;
    const state = {
      ...next,
      root,
      object_path: path,
      object_mapped: doc?.object_mapped,
      object_deletable: doc?.object_deletable,
      selected,
    };
    setDoc(state);
    setSelected(selected);
    return state;
  }
  useEffect(() => {
    const controller = new AbortController();
    api<ObjectState>(
      `/documents/${id}/chunks/objects/open`,
      "POST",
      {
        revision: openingRevision.current,
        object: reference,
      },
      controller.signal,
    )
      .then(async (next) => {
        if (controller.signal.aborted) return;
        const path = next.object_path;
        const rootId = pathId(path);
        const root = await api<NbtNode>(
          recordPath(next, `/nodes/${rootId}`),
          "GET",
          undefined,
          controller.signal,
        );
        if (controller.signal.aborted) return;
        root.name = label;
        root.renameable = false;
        root.deletable = false;
        focus.current = root;
        setDoc({ ...next, root, selected: root });
        setSelected(root);
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      onDraftChange(false);
    };
  }, [id, reference, label, onDraftChange]);

  async function mutate(input: TagInput) {
    if (!doc || !action) throw new Error("当前没有正在编辑的标签");
    setBusy(true);
    try {
      let endpoint = "commands";
      let body: Record<string, unknown> = {
        node_id: action.node.id,
        name: action.node.renameable ? input.name : null,
        value: action.kind === "edit" ? input.value : null,
      };
      if (action.kind === "add") {
        endpoint = "add";
        body = {
          parent_id: action.node.id,
          tag_id: action.tagId,
          name: action.node.tag_id === 10 ? input.name : null,
          value: [9, 10].includes(action.tagId) ? null : input.value,
          list_type: action.tagId === 9 ? input.listType : null,
        };
      } else if (action.kind === "delete") {
        endpoint = "delete";
        body = { node_id: action.node.id };
      } else if (action.kind === "clear") {
        endpoint = "clear";
        body = {};
      }
      const next = await api<DocumentState>(
        `/documents/${id}/${endpoint}`,
        "POST",
        { ...body, revision: doc.revision, record: doc.record },
      );
      onChanged(next);
      await focused(next, doc.object_path);
      draft.current = null;
      onDraftChange(false);
      return next;
    } finally {
      setBusy(false);
    }
  }
  useImperativeHandle(ref, () => ({
    flush: async () => {
      if (busy) throw new Error("对象操作尚未完成，请稍后再试");
      if (draft.current?.dirty && action) {
        const next = await mutate(draft.current.input);
        setAction(null);
        return next;
      }
      return doc ?? undefined;
    },
  }));
  function dismiss() {
    if (busy || action || deleting) return;
    onDraftChange(false);
    onClose();
  }
  async function travel(step: "undo" | "redo") {
    if (!doc || busy) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<DocumentState>(
        `/documents/${id}/${step}`,
        "POST",
        { revision: doc.revision, record: doc.record },
      );
      onChanged(next);
      await focused(next, doc.object_path);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Dialog
        open
        onOpenChange={(open) => {
          if (!open) dismiss();
        }}
      >
        <DialogContent
          className="map-object-dialog"
          onPointerDownOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => {
            if (busy || action || deleting) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {doc?.object_mapped
                ? "结构边界与类型字段；删除只移除区域记录，保留地形方块。"
                : reference === "spawn"
                  ? "编辑 level.dat 中的出生点坐标标签。"
                  : "修改先暂存，关闭此面板后使用地图的保存更改。"}
            </DialogDescription>
          </DialogHeader>
          <div className="map-object-toolbar">
            <Input
              placeholder="搜索标签名称或值…"
              aria-label="搜索对象 NBT"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={!doc || busy || !!action}
            />
            <Button
              variant="outline"
              size="icon"
              aria-label="撤销对象修改"
              disabled={!doc?.can_undo || busy || !!action}
              onClick={() => void travel("undo")}
            >
              <RotateCcw />
            </Button>
            <Button
              variant="outline"
              size="icon"
              aria-label="重做对象修改"
              disabled={!doc?.can_redo || busy || !!action}
              onClick={() => void travel("redo")}
            >
              <RotateCw />
            </Button>
          </div>
          <div className="map-object-tree">
            {doc && selected ? (
              <NbtTree
                key={doc.record}
                doc={doc}
                selected={selected.id}
                query={query}
                onSelect={setSelected}
                disabled={busy || !!action || deleting}
                onDeleteSearch={() => {
                  setSearchDeletion(true);
                  setError("");
                  setDeleting(true);
                }}
                onAction={(next) => {
                  if (busy || action) return;
                  if (
                    next.node.id === focus.current?.id &&
                    (next.kind === "clear" || next.kind === "delete")
                  ) {
                    if (reference !== "spawn" && doc.object_deletable !== false)
                      setDeleting(true);
                    return;
                  }
                  setAction(next);
                }}
              />
            ) : (
              <div className="map-object-loading">
                {error ? "" : "正在读取对象 NBT…"}
              </div>
            )}
          </div>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="destructive"
              disabled={
                !doc ||
                reference === "spawn" ||
                doc.object_deletable === false ||
                busy ||
                !!action ||
                deleting
              }
              onClick={() => {
                setSearchDeletion(false);
                setError("");
                setDeleting(true);
              }}
            >
              <Trash2 />
              删除对象
            </Button>
            <Button
              variant="outline"
              disabled={busy || !!action || deleting}
              onClick={dismiss}
            >
              返回地图
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {action && doc && (
        <TagDialog
          action={action}
          documentId={id}
          record={doc.record}
          onDraftChange={draftChanged}
          onSubmit={mutate}
          onClose={() => {
            setAction(null);
            draft.current = null;
            onDraftChange(false);
          }}
        />
      )}
      <Dialog
        open={deleting}
        onOpenChange={(open) => {
          if (!busy) setDeleting(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 {label}？</DialogTitle>
            <DialogDescription>
              {searchDeletion && reference === "spawn"
                ? "清空此搜索结果所在的 level.dat 全部标签，保留文件和根节点。"
                : searchDeletion && reference.endsWith(":player_spawns")
                  ? "仅清除该玩家的 SpawnX、SpawnY、SpawnZ、SpawnDimension 重生点字段，保留玩家记录。"
                  : reference.startsWith("named:") &&
                      doc?.object_path.length === 0
                    ? "删除此图标对应的整条 NBT 记录，保留地形。村庄仅删除 INFO 记录，保留 POI 等关联记录。保存前可用地图的还原取消。"
                    : "只删除此对象记录，保留同一位置的其他对象和地形。保存前可用地图的还原取消删除。"}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !doc}
              onClick={async () => {
                if (!doc || busy) return;
                setBusy(true);
                setError("");
                try {
                  const next = await api<DocumentState>(
                    `/documents/${id}/chunks/objects/${searchDeletion ? "delete-selection" : "delete"}`,
                    "POST",
                    searchDeletion
                      ? { revision: doc.revision, objects: [reference] }
                      : { revision: doc.revision, object: reference },
                  );
                  onChanged(next);
                  onDraftChange(false);
                  onClose();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              暂存删除对象
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
