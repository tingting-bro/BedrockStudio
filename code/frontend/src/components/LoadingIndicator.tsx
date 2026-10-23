import { useEffect, useState, useSyncExternalStore } from "react";
import { beginLoading, loadingSnapshot, subscribeLoading } from "@/lib/loading";

export function LoadingActivity() {
  useEffect(() => beginLoading(), []);
  return null;
}

export default function LoadingIndicator() {
  const busy = useSyncExternalStore(subscribeLoading, loadingSnapshot);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!busy) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 180);
    return () => window.clearTimeout(timer);
  }, [busy]);
  if (!busy || !visible) return null;
  return (
    <div className="global-loading" role="status" aria-label="正在加载">
      <span className="voxel-spinner" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <i key={i} style={{ "--step": i } as React.CSSProperties} />
        ))}
      </span>
      <span>加载中</span>
    </div>
  );
}
