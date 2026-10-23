import { DropdownMenu as Menu } from "radix-ui";
import {
  ChevronDown,
  Circle,
  Hand,
  MoreHorizontal,
  MousePointer2,
  PaintBucket,
  RectangleHorizontal,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  chunkKinds,
  selectionShapes,
  type ChunkKind,
  type SelectionShape,
  type SelectionCommand,
} from "./map-view";

export type FillOperation = "blocks" | "chunks";

export default function ChunkToolbar({
  selecting,
  shape,
  kinds,
  blocked,
  dataBlocked,
  selectedCount,
  onBrowse,
  onSelect,
  onShape,
  onKinds,
  onSelection,
  onFill,
  onCreate,
  onReset,
}: {
  selecting: boolean;
  shape: SelectionShape;
  kinds: ChunkKind[];
  blocked: boolean;
  dataBlocked: boolean;
  selectedCount: number;
  onBrowse: () => void;
  onSelect: () => void;
  onShape: (shape: SelectionShape) => void;
  onKinds: (kinds: ChunkKind[]) => void;
  onSelection: (kind: SelectionCommand["kind"]) => void;
  onFill: (operation: FillOperation) => void;
  onCreate: () => void;
  onReset: () => void;
}) {
  return (
    <aside
      className="chunk-toolbar"
      role="toolbar"
      aria-orientation="vertical"
      aria-label="地图工具栏"
    >
      <Button
        size="icon"
        variant={!selecting ? "default" : "secondary"}
        disabled={blocked}
        aria-label="移动和查看"
        title="移动和查看"
        aria-pressed={!selecting}
        onClick={onBrowse}
      >
        <Hand />
      </Button>
      <div className="chunk-tool-split">
        <Button
          size="icon"
          variant={selecting ? "default" : "secondary"}
          disabled={dataBlocked}
          aria-label="选择区块"
          title={selectionShapes.find(([key]) => key === shape)?.[1]}
          aria-pressed={selecting}
          onClick={onSelect}
        >
          <MousePointer2 />
        </Button>
        <Menu.Root>
          <Menu.Trigger asChild>
            <Button
              className="chunk-tool-arrow"
              variant="secondary"
              disabled={blocked}
              aria-label="选取设置"
              title="选取设置"
            >
              <ChevronDown />
            </Button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content
              className="chunk-tool-menu"
              side="right"
              align="start"
              sideOffset={8}
            >
              <Menu.RadioGroup
                value={shape}
                onValueChange={(value) => onShape(value as SelectionShape)}
              >
                {selectionShapes.map(([key, label]) => (
                  <Menu.RadioItem
                    key={key}
                    value={key}
                    disabled={dataBlocked}
                    className="chunk-menu-item"
                  >
                    <span className="chunk-menu-mark">
                      {shape === key ? "●" : ""}
                    </span>
                    {key === "circle" ? (
                      <Circle />
                    ) : key === "rectangle" ? (
                      <RectangleHorizontal />
                    ) : (
                      <MousePointer2 />
                    )}
                    {label}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <Menu.Separator className="chunk-menu-separator" />
              <Menu.Label className="chunk-menu-label">选取类型</Menu.Label>
              {chunkKinds.map(([key, label]) => (
                <Menu.CheckboxItem
                  key={key}
                  checked={kinds.includes(key)}
                  disabled={dataBlocked}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) =>
                    onKinds(
                      checked
                        ? [...kinds, key]
                        : kinds.filter((value) => value !== key),
                    )
                  }
                  className="chunk-menu-item"
                >
                  <span className="chunk-menu-mark">
                    {kinds.includes(key) ? "✓" : ""}
                  </span>
                  {label}
                </Menu.CheckboxItem>
              ))}
              <Menu.Separator className="chunk-menu-separator" />
              {(
                [
                  ["all", "全选当前视野"],
                  ["invert", "反选当前视野"],
                  ["clear", "清空选择"],
                ] as const
              ).map(([key, label]) => (
                <Menu.Item
                  key={key}
                  className="chunk-menu-item"
                  disabled={dataBlocked || (key === "clear" && !selectedCount)}
                  onSelect={() => onSelection(key)}
                >
                  {label}
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
      </div>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button
            size="icon"
            variant="secondary"
            disabled={dataBlocked || !selectedCount}
            aria-label="填充"
            title="填充"
          >
            <PaintBucket />
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="chunk-tool-menu"
            side="right"
            align="start"
            sideOffset={8}
          >
            <Menu.Item
              className="chunk-menu-item"
              onSelect={() => onFill("blocks")}
            >
              删除方块
            </Menu.Item>
            <Menu.Item
              className="chunk-menu-item"
              onSelect={() => onFill("chunks")}
            >
              删除区块
            </Menu.Item>
            <Menu.Separator className="chunk-menu-separator" />
            <Menu.Item className="chunk-menu-item" onSelect={onCreate}>
              新增空区块
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button
            size="icon"
            variant="secondary"
            disabled={blocked}
            aria-label="更多地图操作"
            title="更多操作"
          >
            <MoreHorizontal />
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content
            className="chunk-tool-menu"
            side="right"
            align="start"
            sideOffset={8}
          >
            <Menu.Item
              className="chunk-menu-item chunk-menu-danger"
              disabled={dataBlocked}
              onSelect={onReset}
            >
              重置当前维度
            </Menu.Item>
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
    </aside>
  );
}
