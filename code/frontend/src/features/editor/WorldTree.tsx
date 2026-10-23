import { useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FolderOpen } from "lucide-react";
import {
  commonDataCategories,
  dataLabels,
  type DocumentState,
  type EditorScope,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import ScopeContextMenu, { type ScopeDelete } from "./ScopeContextMenu";
import NodeContextMenu from "./NodeContextMenu";
import type { TagAction } from "./tag-types";
import { dataIcons } from "./data-icons";
import MinecraftIcon from "@/components/MinecraftIcon";

export default function WorldTree({
  doc,
  scope,
  disabled,
  onScope,
  onSwitch,
  onAction,
  onDelete,
}: {
  doc: DocumentState;
  scope: EditorScope;
  disabled: boolean;
  onScope: (scope: EditorScope) => void;
  onSwitch: (record: string) => void;
  onAction: (action: TagAction) => void;
  onDelete: (target: ScopeDelete) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [dataExpanded, setDataExpanded] = useState(true);
  const levelActive = scope === "record" && doc.record === "level.dat";
  const levelRow = (
    <button
      className={cn("sidebar-file", levelActive && "selected")}
      role="treeitem"
      aria-level={2}
      aria-selected={levelActive}
      disabled={disabled}
      onClick={() => onSwitch("level.dat")}
    >
      <FileCode2 />
      <span>level.dat</span>
      {doc.records.some(
        (record) => record.id === "level.dat" && record.dirty,
      ) ? (
        <span className="modified-indicator" />
      ) : null}
    </button>
  );
  return (
    <div className="world-file-tree" role="tree" aria-label="世界文件">
      <ScopeContextMenu
        target={{ target: "world", name: doc.world.name }}
        disabled={disabled}
        onDelete={onDelete}
      >
        <div
          className={cn("world-folder-row", scope === "world" && "selected")}
        >
          <button
            className="folder-toggle"
            aria-label={expanded ? "折叠世界" : "展开世界"}
            disabled={disabled}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown /> : <ChevronRight />}
          </button>
          <button
            className="file-tree-folder"
            role="treeitem"
            aria-level={1}
            aria-expanded={expanded}
            aria-selected={scope === "world"}
            title={doc.world.path}
            disabled={disabled}
            onClick={() => onScope("world")}
          >
            <FolderOpen />
            <span>{doc.world.name}</span>
          </button>
        </div>
      </ScopeContextMenu>
      {expanded ? (
        <div role="group">
          {levelActive ? (
            <NodeContextMenu
              node={doc.root}
              disabled={disabled}
              onAction={onAction}
              onSelect={() => {}}
            >
              {levelRow}
            </NodeContextMenu>
          ) : (
            <ScopeContextMenu
              target={{ target: "level", name: "level.dat" }}
              disabled={disabled}
              onDelete={onDelete}
            >
              {levelRow}
            </ScopeContextMenu>
          )}
          <ScopeContextMenu
            target={{ target: "players", name: "players" }}
            disabled={disabled}
            onDelete={onDelete}
          >
            <button
              className={cn("sidebar-file", scope === "players" && "selected")}
              role="treeitem"
              aria-level={2}
              aria-selected={scope === "players"}
              disabled={disabled}
              onClick={() => onScope("players")}
            >
              <MinecraftIcon name="player" />
              <span>players</span>
            </button>
          </ScopeContextMenu>
          {doc.record_kind === "players" ? (
            <ScopeContextMenu
              target={{
                target: "player",
                player: doc.record,
                name: doc.root.name,
              }}
              disabled={disabled}
              onDelete={onDelete}
            >
              <button
                className={cn(
                  "sidebar-file",
                  "sidebar-player",
                  scope === "record" && "selected",
                )}
                role="treeitem"
                aria-level={3}
                aria-selected={scope === "record"}
                title={doc.root.name}
                disabled={disabled}
                onClick={() => onSwitch(doc.record)}
              >
                <MinecraftIcon name="player" />
                <span className="truncate">{doc.root.name}</span>
                {doc.dirty ? <span className="modified-indicator" /> : null}
              </button>
            </ScopeContextMenu>
          ) : null}
          {commonDataCategories.map((category) => {
            const Icon = dataIcons[category];
            return (
              <div key={category}>
                <ScopeContextMenu
                  target={{ target: category, name: dataLabels[category] }}
                  disabled={disabled}
                  onDelete={onDelete}
                >
                  <button
                    className={cn(
                      "sidebar-file",
                      scope === category && "selected",
                    )}
                    role="treeitem"
                    aria-level={2}
                    aria-selected={scope === category}
                    disabled={disabled}
                    onClick={() => onScope(category)}
                  >
                    <Icon />
                    <span>{dataLabels[category]}</span>
                  </button>
                </ScopeContextMenu>
                {doc.record_kind === category ? (
                  <ScopeContextMenu
                    target={{
                      target: "record",
                      record: doc.record,
                      name: doc.root.name,
                    }}
                    disabled={disabled}
                    onDelete={onDelete}
                  >
                    <button
                      className={cn(
                        "sidebar-file",
                        "sidebar-player",
                        scope === "record" && "selected",
                      )}
                      role="treeitem"
                      aria-level={3}
                      aria-selected={scope === "record"}
                      title={doc.root.name}
                      disabled={disabled}
                      onClick={() => onSwitch(doc.record)}
                    >
                      <FileCode2 />
                      <span className="truncate">{doc.root.name}</span>
                      {doc.dirty ? (
                        <span className="modified-indicator" />
                      ) : null}
                    </button>
                  </ScopeContextMenu>
                ) : null}
              </div>
            );
          })}
          <ScopeContextMenu
            target={{ target: "data", name: "data" }}
            disabled={disabled}
            onDelete={onDelete}
          >
            <div
              className={cn(
                "world-folder-row",
                "data-folder-row",
                scope === "data" && "selected",
              )}
            >
              <button
                className="folder-toggle"
                aria-label={dataExpanded ? "折叠 data" : "展开 data"}
                disabled={disabled}
                onClick={() => setDataExpanded(!dataExpanded)}
              >
                {dataExpanded ? <ChevronDown /> : <ChevronRight />}
              </button>
              <button
                className="file-tree-folder"
                role="treeitem"
                aria-level={2}
                aria-expanded={dataExpanded}
                aria-selected={scope === "data"}
                disabled={disabled}
                onClick={() => onScope("data")}
              >
                <FolderOpen />
                <span>data</span>
              </button>
            </div>
          </ScopeContextMenu>
          {dataExpanded ? (
            <div role="group">
              {doc.record_kind === "other" ? (
                <ScopeContextMenu
                  target={{
                    target: "record",
                    record: doc.record,
                    name: doc.root.name,
                  }}
                  disabled={disabled}
                  onDelete={onDelete}
                >
                  <button
                    className={cn(
                      "sidebar-file",
                      "sidebar-data",
                      scope === "record" && "selected",
                    )}
                    role="treeitem"
                    aria-level={3}
                    aria-selected={scope === "record"}
                    title={doc.root.name}
                    disabled={disabled}
                    onClick={() => onSwitch(doc.record)}
                  >
                    <FileCode2 />
                    <span className="truncate">{doc.root.name}</span>
                    {doc.dirty ? <span className="modified-indicator" /> : null}
                  </button>
                </ScopeContextMenu>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
