import { useEffect, useState } from "react";
import { Keyboard, Monitor, RotateCcw, Settings2 } from "lucide-react";
import { api } from "@/lib/api";
import { FLIGHT_SPEED, RENDER_DISTANCE } from "@/lib/constants";
import {
  defaultPreferences,
  shortcutBinding,
  shortcutDefinitions,
  shortcutError,
  shortcutLabel,
  type Preferences,
  type ShortcutAction,
} from "@/lib/preferences";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export default function AppSettings({
  open,
  value,
  loadError,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  value: Preferences;
  loadError: string;
  onOpenChange: (open: boolean) => void;
  onSaved: (value: Preferences) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [tab, setTab] = useState<"general" | "shortcuts">("general");
  const [recording, setRecording] = useState<ShortcutAction | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) {
      setDraft(structuredClone(value));
      setRecording(null);
      setError("");
    }
  }, [open, value]);
  const conflict =
    !Number.isInteger(draft.default_render_distance) ||
    draft.default_render_distance < RENDER_DISTANCE.min ||
    draft.default_render_distance > RENDER_DISTANCE.max
      ? `默认区块视距必须是 ${RENDER_DISTANCE.min}～${RENDER_DISTANCE.max} 的整数`
      : !Number.isFinite(draft.default_flight_speed) ||
          draft.default_flight_speed < FLIGHT_SPEED.min ||
          draft.default_flight_speed > FLIGHT_SPEED.max
        ? `默认飞行速度必须在 ${FLIGHT_SPEED.min}～${FLIGHT_SPEED.max} 格/秒之间`
        : shortcutError(draft.shortcuts);
  async function save() {
    if (conflict || recording) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<Preferences>("/preferences", "POST", draft);
      onSaved(next);
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent
        className="app-settings"
        showCloseButton={!busy}
        onEscapeKeyDown={(event) => {
          if (busy || recording) {
            event.preventDefault();
            setRecording(null);
          }
        }}
        onPointerDownOutside={(event) => {
          if (busy) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            <Settings2 /> 应用设置
          </DialogTitle>
          <DialogDescription>
            更改操作习惯与显示偏好，默认视图、视距和飞行速度在下次进入时生效。
          </DialogDescription>
        </DialogHeader>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label="设置分类">
            <Button
              variant={tab === "general" ? "default" : "ghost"}
              onClick={() => {
                setTab("general");
                setRecording(null);
              }}
            >
              <Monitor /> 常规
            </Button>
            <Button
              variant={tab === "shortcuts" ? "default" : "ghost"}
              onClick={() => setTab("shortcuts")}
            >
              <Keyboard /> 快捷键
            </Button>
          </nav>
          <div className="settings-content">
            {tab === "general" ? (
              <>
                <h3>存档列表</h3>
                <label className="settings-row">
                  <span>
                    卡片布局<small>按习惯选择封面网格或紧凑列表</small>
                  </span>
                  <select
                    value={draft.world_layout}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        world_layout: e.target
                          .value as Preferences["world_layout"],
                      })
                    }
                  >
                    <option value="grid">封面网格</option>
                    <option value="list">紧凑列表</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>显示世界封面</span>
                  <input
                    type="checkbox"
                    checked={draft.show_covers}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, show_covers: e.target.checked })
                    }
                  />
                </label>
                <h3>编辑器与界面</h3>
                <label className="settings-row">
                  <span>
                    默认地图视图<small>下次进入区块编辑器时使用</small>
                  </span>
                  <select
                    value={draft.default_view}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        default_view: e.target
                          .value as Preferences["default_view"],
                      })
                    }
                  >
                    <option value="2d">2D</option>
                    <option value="3d">3D</option>
                    <option value="map">地图俯视</option>
                  </select>
                </label>
                <label className="settings-row">
                  <span>
                    默认区块视距
                    <small>
                      {RENDER_DISTANCE.min}～{RENDER_DISTANCE.max}{" "}
                      区块，下次进入 2D / 3D 编辑器时使用
                    </small>
                  </span>
                  <input
                    type="number"
                    aria-label="默认区块视距"
                    min={RENDER_DISTANCE.min}
                    max={RENDER_DISTANCE.max}
                    step={1}
                    value={
                      Number.isFinite(draft.default_render_distance)
                        ? draft.default_render_distance
                        : ""
                    }
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        default_render_distance:
                          e.target.value.trim() === ""
                            ? NaN
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="settings-row">
                  <span>
                    默认飞行速度
                    <small>
                      {FLIGHT_SPEED.min}～{FLIGHT_SPEED.max} 格/秒，下次进入 2D
                      / 3D 编辑器时使用
                    </small>
                  </span>
                  <input
                    type="number"
                    aria-label="默认飞行速度（格每秒）"
                    min={FLIGHT_SPEED.min}
                    max={FLIGHT_SPEED.max}
                    step="any"
                    value={
                      Number.isFinite(draft.default_flight_speed)
                        ? draft.default_flight_speed
                        : ""
                    }
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        default_flight_speed:
                          e.target.value.trim() === ""
                            ? NaN
                            : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="settings-row">
                  <span>减少界面动画</span>
                  <input
                    type="checkbox"
                    checked={draft.reduced_motion}
                    disabled={busy}
                    onChange={(e) =>
                      setDraft({ ...draft, reduced_motion: e.target.checked })
                    }
                  />
                </label>
              </>
            ) : (
              <>
                <h3>自定义快捷键</h3>
                <p className="settings-help">
                  点击按键后按下新的组合键；Esc 取消录入。Ctrl 在 macOS 上对应
                  Command。飞行 WASD、升降与变换键保持固定。
                </p>
                <div className="shortcut-list">
                  {shortcutDefinitions.map(([id, label, scope]) => (
                    <div className="settings-row" key={id}>
                      <span>
                        {label}
                        <small>{scope}</small>
                      </span>
                      <Button
                        variant="outline"
                        className={recording === id ? "shortcut-recording" : ""}
                        disabled={busy}
                        aria-label={`${label}快捷键`}
                        aria-pressed={recording === id}
                        onBlur={() => {
                          if (recording === id) setRecording(null);
                        }}
                        onClick={() =>
                          setRecording(recording === id ? null : id)
                        }
                        onKeyDown={(event) => {
                          if (recording !== id) return;
                          event.preventDefault();
                          event.stopPropagation();
                          if (event.key === "Escape") {
                            setRecording(null);
                            return;
                          }
                          if (event.repeat || event.nativeEvent.isComposing)
                            return;
                          const binding = shortcutBinding(event.nativeEvent);
                          if (!binding) return;
                          setDraft({
                            ...draft,
                            shortcuts: { ...draft.shortcuts, [id]: binding },
                          });
                          setRecording(null);
                        }}
                      >
                        {recording === id ? (
                          "请按下组合键…"
                        ) : (
                          <kbd>{shortcutLabel(draft.shortcuts[id])}</kbd>
                        )}
                      </Button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        {(error || conflict || loadError) && (
          <p className="settings-error" role="alert">
            {error ||
              conflict ||
              `设置读取失败：${loadError}。当前使用默认值，保存失败时可取消后重试。`}
          </p>
        )}
        <DialogFooter className="settings-footer">
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(defaultPreferences());
              setRecording(null);
              setError("");
            }}
          >
            <RotateCcw /> 恢复默认
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            disabled={busy || !!conflict || !!recording}
            onClick={() => void save()}
          >
            {busy ? "保存中…" : "保存设置"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
