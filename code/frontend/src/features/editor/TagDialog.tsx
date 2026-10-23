import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectGroup,
  SelectItem,
} from "@/components/ui/select";
import { api, recordPath } from "@/lib/api";
import { TAG_TYPES, isArray, type TagAction, type TagInput } from "./tag-types";

export default function TagDialog({
  action,
  documentId,
  record,
  onClose,
  onSubmit,
  onDraftChange,
}: {
  action: TagAction;
  documentId: string;
  record: string;
  onClose: () => void;
  onSubmit: (input: TagInput) => Promise<unknown>;
  onDraftChange: (changed: boolean, input: TagInput) => void;
}) {
  const adding = action.kind === "add";
  const deleting = action.kind === "delete" || action.kind === "clear";
  const tagId = adding ? action.tagId : action.node.tag_id;
  const typeName =
    TAG_TYPES.find((type) => type.id === tagId)?.name ?? action.node.type;
  const [name, setName] = useState(adding ? "" : action.node.name);
  const [value, setValue] = useState(
    adding
      ? [1, 2, 3, 4, 5, 6].includes(tagId)
        ? "0"
        : ""
      : (action.node.value ?? ""),
  );
  const [initialValue, setInitialValue] = useState(value);
  const [listType, setListType] = useState(10);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(
    action.kind === "edit" && isArray(tagId),
  );
  const [error, setError] = useState("");
  const [loadFailed, setLoadFailed] = useState(false);
  const showName =
    action.kind === "rename" ||
    (adding && action.node.tag_id === 10) ||
    (action.kind === "edit" && action.node.renameable);
  const showValue =
    action.kind === "edit" || (adding && ![9, 10].includes(tagId));
  useEffect(() => {
    if (!loading) return;
    let active = true;
    api<{ value: string }>(
      recordPath({ id: documentId, record }, `/nodes/${action.node.id}/value`),
    )
      .then((result) => {
        if (active) {
          setValue(result.value);
          setInitialValue(result.value);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setLoadFailed(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [documentId, record, action.node.id]);
  useEffect(() => {
    onDraftChange(
      !deleting &&
        (name !== (adding ? "" : action.node.name) ||
          value !== initialValue ||
          (adding && listType !== 10)),
      { name, value, listType },
    );
  }, [
    name,
    value,
    initialValue,
    listType,
    adding,
    deleting,
    action,
    onDraftChange,
  ]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || loading || loadFailed) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit({ name, value, listType });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const title = adding
    ? `新增 ${typeName} 标签`
    : deleting
      ? action.kind === "clear"
        ? "删除全部子标签"
        : "删除标签"
      : action.kind === "rename"
        ? "重命名标签"
        : `编辑 ${typeName} 标签`;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        className="tag-dialog"
        onEscapeKeyDown={(e) => {
          if (busy) e.preventDefault();
        }}
        onPointerDownOutside={(e) => e.preventDefault()}
      >
        <form onSubmit={(e) => void submit(e)}>
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="break-all">
              {adding && action.records && action.records.length > 1
                ? `向选中的 ${action.records.length} 条记录分别新增同名、同类型和同值的根标签。`
                : action.kind === "clear"
                  ? `删除「${action.node.name}」下的全部标签？保留根节点，可以通过撤销恢复。`
                  : action.kind === "delete"
                    ? `删除「${action.node.name}」${action.node.container ? "及其全部子标签" : ""}？可以通过撤销恢复。`
                    : `${adding ? "父节点" : "节点"}：${action.node.path_label}`}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-6 gap-5">
            {showName ? (
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor="tag-name">名称</FieldLabel>
                <Input
                  id="tag-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  disabled={busy || loading}
                  autoFocus
                  aria-invalid={!!error}
                />
              </Field>
            ) : null}
            {showValue ? (
              <Field data-invalid={!!error}>
                <FieldLabel htmlFor="tag-value">值</FieldLabel>
                {tagId === 8 || isArray(tagId) ? (
                  <Textarea
                    id="tag-value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={busy || loading}
                    autoFocus={!showName}
                    className="min-h-32 max-h-64 font-mono"
                    aria-invalid={!!error}
                  />
                ) : (
                  <Input
                    id="tag-value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    disabled={busy || loading}
                    autoFocus={!showName}
                    className="font-mono"
                    aria-invalid={!!error}
                  />
                )}
                <FieldDescription>
                  {loading
                    ? "正在读取数组…"
                    : isArray(tagId)
                      ? "整数用逗号、空格或换行分隔；留空表示空数组。"
                      : tagId === 4
                        ? "支持完整的 64 位有符号整数。"
                        : tagId === 8
                          ? "支持中文、空字符串和换行。"
                          : "数值必须符合所选 NBT 类型的范围。"}
                </FieldDescription>
              </Field>
            ) : null}
            {adding && tagId === 9 ? (
              <Field>
                <FieldLabel htmlFor="list-type">元素类型</FieldLabel>
                <Select
                  value={String(listType)}
                  onValueChange={(v) => setListType(Number(v))}
                  disabled={busy}
                >
                  <SelectTrigger id="list-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {TAG_TYPES.map((type) => (
                        <SelectItem value={String(type.id)} key={type.id}>
                          {type.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription>
                  创建空 List，之后右键新增相同类型的元素。
                </FieldDescription>
              </Field>
            ) : null}
            {adding && tagId === 10 ? (
              <FieldDescription>
                创建空 Compound，之后右键新增子标签。
              </FieldDescription>
            ) : null}
            {adding && action.node.tag_id !== 10 ? (
              <FieldDescription>
                元素追加到末尾，索引自动分配。
              </FieldDescription>
            ) : null}
            {error ? <FieldError>{error}</FieldError> : null}
          </FieldGroup>
          <DialogFooter>
            <Button
              variant="outline"
              type="button"
              onClick={onClose}
              disabled={busy}
            >
              取消
            </Button>
            <Button
              variant={deleting ? "destructive" : "default"}
              type="submit"
              disabled={busy || loading || loadFailed}
            >
              {busy ? "处理中…" : deleting ? "删除" : "确定"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
