import { ArrowLeft, ArrowRight, Settings2 } from "lucide-react";
import { WorldCover } from "./WorldPicker";
import PixelIcon from "@/components/PixelIcon";
import { toast } from "sonner";
import { useState } from "react";
import { api, type DocumentState } from "@/lib/api";
import { Brand } from "@/components/Brand";
import { Button } from "@/components/ui/button";

export default function ModePicker({
  doc,
  onChoose,
  onClose,
  onSettings,
}: {
  doc: DocumentState;
  onChoose: (mode: "nbt" | "chunks") => void;
  onClose: () => void;
  onSettings?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  async function back() {
    setBusy(true);
    try {
      await api(`/documents/${doc.id}`, "DELETE");
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mode-page">
      <header className="mode-header">
        <Button
          variant="ghost"
          aria-label="退出存档"
          disabled={busy}
          onClick={() => void back()}
        >
          <ArrowLeft />
          退出存档
        </Button>
        <Brand />
        <span className="mode-world" title={doc.world.path}>
          {doc.world.name}
        </span>
        <Button variant="ghost" onClick={onSettings} disabled={busy}>
          <Settings2 /> 设置
        </Button>
      </header>
      <main className="mode-main">
        <div className="mode-heading">
          <span className="workspace-label">准备开始</span>
          <h1>选择编辑模式</h1>
          <p>同一个世界，两种编辑方式。</p>
        </div>
        <div className="mode-workspace">
          <aside className="mode-world-summary">
            <WorldCover world={doc.world} />
            <div>
              <span className="workspace-label">当前世界</span>
              <h2>{doc.world.name}</h2>
              <p>
                {doc.world.mode} · v{doc.world.version}
              </p>
              <p className="mode-world-path" title={doc.world.path}>
                {doc.world.folder_name}
              </p>
            </div>
          </aside>
          <div className="mode-cards">
            <button
              className="mode-card"
              disabled={busy}
              onClick={() => onChoose("nbt")}
            >
              <span className="mode-icon">
                <PixelIcon kind="file" />
              </span>
              <span className="mode-number">01 / 数据</span>
              <h2>NBT 数据编辑</h2>
              <p>level.dat、玩家和 data 记录</p>
              <div className="mode-features">
                <span>世界属性</span>
                <span>玩家数据</span>
                <span>NBT 树</span>
              </div>
              <span className="mode-enter">
                进入编辑 <ArrowRight />
              </span>
            </button>
            <button
              className="mode-card mode-card-map"
              disabled={busy}
              onClick={() => onChoose("chunks")}
            >
              <span className="mode-icon">
                <PixelIcon kind="map" />
              </span>
              <span className="mode-number">02 / 世界</span>
              <h2>世界区块编辑</h2>
              <p>世界地图、维度和区块清理</p>
              <div className="mode-features">
                <span>2D / 3D</span>
                <span>方块编辑</span>
                <span>区块管理</span>
              </div>
              <span className="mode-enter">
                进入地图 <ArrowRight />
              </span>
            </button>
          </div>
        </div>
        <div className="mode-bottom">
          <span>偏好会保留到下次启动</span>
          <Button variant="ghost" onClick={onSettings}>
            <Settings2 /> 调整设置与快捷键 <ArrowRight />
          </Button>
        </div>
      </main>
    </div>
  );
}
