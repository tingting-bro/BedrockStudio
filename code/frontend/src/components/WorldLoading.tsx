export interface WorldLoadingProgress {
  stage: string;
  loaded?: number;
  total?: number | null;
  unit?: "bytes" | "chunks";
}

export default function WorldLoading({
  stage,
  loaded = 0,
  total,
  unit = "bytes",
}: WorldLoadingProgress) {
  const percent =
    total && Number.isFinite(total) && total > 0 && Number.isFinite(loaded)
      ? Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)))
      : undefined;
  const detail =
    unit === "chunks"
      ? `${loaded} / ${total ?? 0} 个区块`
      : loaded > 0
        ? `${(loaded / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ""} MB`
        : "";
  return (
    <div className="world-loading" role="status" aria-live="polite">
      <div className="world-loading-card">
        <div className="world-loading-title">正在加载…</div>
        <div className="world-loading-body">
          <p>{stage}</p>
          <p className="world-loading-tip">正在准备世界，请稍候。</p>
          <div
            className="world-loading-track"
            role="progressbar"
            aria-label={stage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div
              className={`world-loading-fill${percent === undefined ? " world-loading-indeterminate" : ""}`}
              style={
                percent === undefined ? undefined : { width: `${percent}%` }
              }
            />
          </div>
          <small>{detail || "\u00a0"}</small>
        </div>
      </div>
    </div>
  );
}
