import { useContext, useEffect, useState, type ReactElement } from "react";
import {
  api,
  dataCategories,
  dataLabels,
  isDataCategory,
  type DataCategory,
  type RecordCategory,
  type RecordCapabilities,
} from "@/lib/api";
import { Plus, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";

import { RecordMenuContext } from "./RecordMenuContext";
import { TAG_TYPES } from "./tag-types";

export type ScopeDelete = {
  target:
    "player" | "players" | "world" | "level" | "record" | "data" | DataCategory;
  name: string;
  player?: string;
  record?: string;
  records?: string[];
};
export function deleteLabel(target: ScopeDelete["target"], count = 1) {
  if (count > 1)
    return `删除选中的 ${count} 条${target === "player" ? "玩家" : ""}记录…`;
  if (target === "player") return "删除玩家记录…";
  if (target === "players") return "删除全部玩家记录…";
  if (target === "level") return "删除全部标签…";
  if (target === "record") return "删除记录…";
  if (target === "data") return "删除 data 下全部记录…";
  if (isDataCategory(target)) return `删除 ${dataLabels[target]} 下全部记录…`;
  return "删除世界下全部编辑内容…";
}
export function deleteDescription(deletion: ScopeDelete) {
  if (deletion.records?.includes("level.dat"))
    return `删除选中的 ${deletion.records.length} 条不同记录及其全部数据？其中 level.dat 保留文件并清空全部标签。`;
  if (deletion.records && deletion.records.length > 0)
    return `删除选中的 ${deletion.records.length} 条${deletion.target === "player" ? "玩家" : ""}记录及其全部数据？`;
  if (deletion.target === "world") {
    return `清空「${deletion.name}」的 level.dat 全部标签，并删除所有玩家记录？保留 data、区块和其他世界数据。`;
  }
  if (deletion.target === "players") {
    return "删除该世界的全部玩家记录？包含当前筛选和分页之外的玩家。";
  }
  if (deletion.target === "level")
    return "删除 level.dat 下全部标签？保留文件和根节点。";
  if (deletion.target === "data") {
    return "删除 data 下的全部其他 NBT 记录？包含筛选和分页之外的记录，保留 Maps、Tickingareas、Structures、Portals 和 scoreboard。";
  }
  if (isDataCategory(deletion.target)) {
    return `删除 ${dataLabels[deletion.target]} 下的全部记录？包含筛选和分页之外的记录。`;
  }
  if (deletion.target === "record")
    return `删除「${deletion.name}」及其全部数据？`;
  return `删除玩家「${deletion.name}」及其全部数据？`;
}
export default function ScopeContextMenu({
  target,
  disabled,
  onDelete,
  onPrepare,
  children,
}: {
  target: ScopeDelete;
  disabled: boolean;
  onDelete: (target: ScopeDelete) => void;
  onPrepare?: () => void;
  children: ReactElement;
}) {
  const commands = useContext(RecordMenuContext);
  const [open, setOpen] = useState(false);
  const [capabilities, setCapabilities] = useState<RecordCapabilities | null>(
    null,
  );
  const record =
    target.target === "level" ? "level.dat" : (target.player ?? target.record);
  const selectionKey = JSON.stringify(target.records ?? []);
  const multiple = (target.records?.length ?? 0) > 1;
  const category =
    target.target === "players" || isDataCategory(target.target)
      ? target.target
      : null;
  const categories: RecordCategory[] =
    target.target === "world"
      ? ["players", ...dataCategories]
      : [...dataCategories];
  useEffect(() => {
    setCapabilities(null);
    if (!open || !commands) return;
    let active = true;
    const query = new URLSearchParams({ revision: String(commands.revision) });
    if (record) query.set("record", record);
    const request = multiple
      ? api<RecordCapabilities>(
          `/documents/${commands.documentId}/record-selection/capabilities`,
          "POST",
          {
            revision: commands.revision,
            records: JSON.parse(selectionKey),
          },
        )
      : api<RecordCapabilities>(
          `/documents/${commands.documentId}/record-capabilities?${query}`,
        );
    request
      .then((next) => {
        if (active) setCapabilities(next);
      })
      .catch(() => {
        if (active) setCapabilities(null);
      });
    return () => {
      active = false;
    };
  }, [
    open,
    commands?.documentId,
    commands?.revision,
    record,
    selectionKey,
    multiple,
  ]);
  const canCreate = (kind: RecordCategory | DataCategory) =>
    !disabled && !!capabilities?.categories.some((item) => item === kind);
  return (
    <ContextMenu
      onOpenChange={(next) => {
        if (next) onPrepare?.();
        setCapabilities(null);
        setOpen(next);
      }}
    >
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-60"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuGroup>
          <ContextMenuLabel className="truncate">
            {multiple ? `已选 ${target.records!.length} 条记录` : target.name}
          </ContextMenuLabel>
          {record ? (
            <ContextMenuSub>
              <ContextMenuSubTrigger
                disabled={disabled || !capabilities?.tag_types.length}
              >
                <Plus className="mr-2" />
                新增标签
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="max-h-96 overflow-y-auto w-44">
                <ContextMenuGroup>
                  {TAG_TYPES.map((type) => (
                    <ContextMenuItem
                      key={type.id}
                      disabled={
                        disabled || !capabilities?.tag_types.includes(type.id)
                      }
                      onSelect={() =>
                        multiple
                          ? commands?.onAddTag(record, type.id, target.records)
                          : commands?.onAddTag(record, type.id)
                      }
                    >
                      {type.name}
                    </ContextMenuItem>
                  ))}
                </ContextMenuGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          ) : category ? (
            <ContextMenuItem
              disabled={!canCreate(category)}
              onSelect={() => {
                if (category !== "scoreboard" && category !== "other")
                  commands?.onCreate(category);
              }}
            >
              <Plus />
              {category === "players" ? "新增玩家记录…" : "新增记录…"}
            </ContextMenuItem>
          ) : (
            <ContextMenuSub>
              <ContextMenuSubTrigger disabled={!categories.some(canCreate)}>
                <Plus className="mr-2" />
                新增记录
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                <ContextMenuGroup>
                  {categories.map((kind) => (
                    <ContextMenuItem
                      key={kind}
                      disabled={!canCreate(kind)}
                      onSelect={() => commands?.onCreate(kind)}
                    >
                      {kind === "players" ? "players" : dataLabels[kind]}
                    </ContextMenuItem>
                  ))}
                </ContextMenuGroup>
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            disabled={disabled}
            onSelect={() => onDelete(target)}
          >
            <Trash2 />
            {deleteLabel(target.target, target.records?.length)}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
