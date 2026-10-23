import { useState } from "react";
import { Input } from "@/components/ui/input";

export default function ViewAngle({
  label,
  value,
  disabled,
  onCommit,
}: {
  label: "偏航" | "俯仰";
  value: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label
      title={
        label === "偏航"
          ? "0° 南，90° 西，±180° 北，-90° 东"
          : "正数向下，负数向上；范围 -90°～90°"
      }
    >
      {label}
      <Input
        aria-label={`视角${label}（度）`}
        type="number"
        step="any"
        disabled={disabled}
        value={draft ?? String(value)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") setDraft(null);
        }}
        onBlur={() => {
          if (draft !== null && draft.trim()) {
            const next = Number(draft);
            if (Number.isFinite(next)) onCommit(next);
          }
          setDraft(null);
        }}
      />
      <small>°</small>
    </label>
  );
}
