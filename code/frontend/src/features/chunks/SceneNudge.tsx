import { useState } from "react";
import { Button } from "@/components/ui/button";
import type { VoxelPoint } from "./scene-data";
import { nudgeSelection } from "./scene-selection";

export default function SceneNudge({
  corners,
  disabled,
  sphere,
  onChange,
}: {
  corners: VoxelPoint[];
  disabled: boolean;
  sphere: boolean;
  onChange: (corners: VoxelPoint[]) => void;
}) {
  const [target, setTarget] = useState<"first" | "second" | "box">("box");
  const [step, setStep] = useState(1);
  return (
    <div className="scene-nudge">
      <div
        className="scene-nudge-targets"
        role="group"
        aria-label="移动选区目标"
      >
        {(["first", "second", "box"] as const)
          .filter((t) => !sphere || t === "box")
          .map((t, i) => (
            <Button
              key={t}
              size="sm"
              variant={target === t ? "default" : "secondary"}
              disabled={disabled || corners.length !== 2}
              onClick={() => setTarget(t)}
            >
              {sphere ? "移动球心" : ["移动点 1", "移动点 2", "移动框"][i]}
            </Button>
          ))}
      </div>
      <label>
        步长
        <select
          aria-label="选区移动步长"
          value={step}
          disabled={disabled}
          onChange={(e) => setStep(Number(e.target.value))}
        >
          {[1, 4, 16].map((n) => (
            <option key={n} value={n}>
              {n} 格
            </option>
          ))}
        </select>
      </label>
      <div className="scene-nudge-axes">
        {(["x", "y", "z"] as const).map((axis) => (
          <div key={axis}>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`选区 ${axis.toUpperCase()} 减少`}
              disabled={disabled || corners.length !== 2}
              onClick={() =>
                onChange(
                  nudgeSelection(corners, sphere ? "box" : target, {
                    x: 0,
                    y: 0,
                    z: 0,
                    [axis]: -step,
                  }),
                )
              }
            >
              −{axis.toUpperCase()}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              aria-label={`选区 ${axis.toUpperCase()} 增加`}
              disabled={disabled || corners.length !== 2}
              onClick={() =>
                onChange(
                  nudgeSelection(corners, sphere ? "box" : target, {
                    x: 0,
                    y: 0,
                    z: 0,
                    [axis]: step,
                  }),
                )
              }
            >
              +{axis.toUpperCase()}
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}
