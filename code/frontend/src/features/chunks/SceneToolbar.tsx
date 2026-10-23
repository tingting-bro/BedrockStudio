import { useRef } from "react";
import { DropdownMenu as Menu } from "radix-ui";
import {
  BoxSelect,
  ClipboardPaste,
  Download,
  Grid2X2,
  Hand,
  PaintBucket,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export type SceneTool = "browse" | "select" | "fill";
export type StructureFormat = "mcstructure" | "schematic" | "schem";
export interface SceneFill {
  serial: number;
  block: string;
}

export default function SceneToolbar({
  tool,
  disabled,
  pasteOpen,
  canPaste,
  onTool,
  onPaste,
  onExport,
  onImport,
  onChunks,
}: {
  tool: SceneTool;
  disabled: boolean;
  pasteOpen: boolean;
  canPaste: boolean;
  onTool: (tool: SceneTool) => void;
  onPaste: () => void;
  onExport: (format: StructureFormat) => void;
  onImport: (file: File) => void;
  onChunks: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <nav className="scene-tool-tabs" aria-label="3D 编辑工具">
      {(
        [
          ["browse", "浏览", Hand],
          ["select", "选取", BoxSelect],
        ] as const
      ).map(([key, label, Icon]) => (
        <Button
          key={key}
          variant={tool === key && !pasteOpen ? "default" : "secondary"}
          aria-pressed={tool === key && !pasteOpen}
          disabled={disabled}
          onClick={() => onTool(key)}
        >
          <Icon />
          {label}
        </Button>
      ))}
      <Button
        variant={pasteOpen ? "default" : "secondary"}
        aria-pressed={pasteOpen}
        disabled={disabled || !canPaste}
        onClick={onPaste}
      >
        <ClipboardPaste />
        粘贴
      </Button>
      <Button
        variant={tool === "fill" && !pasteOpen ? "default" : "secondary"}
        aria-pressed={tool === "fill" && !pasteOpen}
        disabled={disabled}
        onClick={() => onTool("fill")}
      >
        <PaintBucket />
        操作
      </Button>
      <span className="scene-tool-divider" />
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <Upload />
        导入
      </Button>
      <input
        ref={input}
        type="file"
        hidden
        accept=".mcstructure,.schematic,.schem"
        disabled={disabled}
        onChange={(event) => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = "";
          if (file) onImport(file);
        }}
      />
      <Menu.Root>
        <Menu.Trigger asChild>
          <Button variant="secondary" disabled={disabled}>
            <Download />
            导出
          </Button>
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Content className="chunk-tool-menu" side="top" sideOffset={8}>
            {(
              [
                ["mcstructure", "Bedrock mcstructure"],
                ["schematic", "Schematic"],
                ["schem", "Sponge schem"],
              ] as const
            ).map(([format, label]) => (
              <Menu.Item
                className="chunk-menu-item"
                key={format}
                onSelect={() => onExport(format)}
              >
                {label}
              </Menu.Item>
            ))}
          </Menu.Content>
        </Menu.Portal>
      </Menu.Root>
      <Button
        variant="secondary"
        disabled={disabled}
        onClick={onChunks}
        title="切换到 2D 区块工具"
      >
        <Grid2X2 />
        区块
      </Button>
    </nav>
  );
}
