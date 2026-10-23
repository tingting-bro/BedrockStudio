import { Button } from "@/components/ui/button";
import { Trash2 } from "lucide-react";

export default function SelectionBar({
  count,
  disabled,
  busy,
  error,
  onAll,
  onClear,
  onDelete,
}: {
  count: number;
  disabled: boolean;
  busy?: boolean;
  error?: string;
  onAll: () => void;
  onClear: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="record-selection-bar">
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={onAll}
        >
          {busy ? "正在全选…" : "全选"}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled || busy || !count}
          onClick={onClear}
        >
          清空选择
        </Button>
        <Button
          variant="destructive"
          size="sm"
          disabled={disabled || busy || !count}
          onClick={onDelete}
        >
          <Trash2 />
          删除所选
        </Button>
        <span>已选 {count}</span>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
