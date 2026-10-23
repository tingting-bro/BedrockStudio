import type { ReactElement } from "react";
import { Pencil, Plus, TextCursorInput, Trash2 } from "lucide-react";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubTrigger,
  ContextMenuSubContent,
} from "@/components/ui/context-menu";
import type { NbtNode } from "@/lib/api";
import { TAG_TYPES, type TagAction } from "./tag-types";

export default function NodeContextMenu({
  node,
  disabled,
  onAction,
  onSelect,
  children,
}: {
  node: NbtNode;
  disabled: boolean;
  onAction: (action: TagAction) => void;
  onSelect: (node: NbtNode) => void;
  children: ReactElement;
}) {
  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) onSelect(node);
      }}
    >
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent
        className="w-52"
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        <ContextMenuGroup>
          <ContextMenuLabel className="max-w-48 truncate">
            {node.name || "（空名称）"}
          </ContextMenuLabel>
          <ContextMenuSub>
            <ContextMenuSubTrigger
              disabled={disabled || node.allowed_child_types.length === 0}
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
                      disabled || !node.allowed_child_types.includes(type.id)
                    }
                    onSelect={() =>
                      onAction({ kind: "add", node, tagId: type.id })
                    }
                  >
                    {type.name}
                  </ContextMenuItem>
                ))}
              </ContextMenuGroup>
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuItem
            disabled={disabled || !node.editable}
            onSelect={() => onAction({ kind: "edit", node })}
          >
            <Pencil />
            编辑值…
          </ContextMenuItem>
          <ContextMenuItem
            disabled={disabled || !node.renameable}
            onSelect={() => onAction({ kind: "rename", node })}
          >
            <TextCursorInput />
            重命名…
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem
            variant="destructive"
            disabled={
              disabled ||
              (node.path.length === 0
                ? node.child_count === 0
                : !node.deletable)
            }
            onSelect={() =>
              onAction({
                kind: node.path.length === 0 ? "clear" : "delete",
                node,
              })
            }
          >
            <Trash2 />
            {node.path.length === 0 ? "删除全部子标签…" : "删除标签…"}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}
