import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldError,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { dataLabels, type RecordCategory } from "@/lib/api";

export const recordPrefixes: Record<RecordCategory, string> = {
  players: "player_",
  maps: "map_",
  tickingareas: "tickingarea_",
  structures: "structuretemplate_",
  portals: "portals",
};

export default function RecordDialog({
  category,
  disabled,
  onClose,
  onSubmit,
  onDraftChange,
}: {
  category: RecordCategory;
  disabled: boolean;
  onClose: () => void;
  onSubmit: (name: string) => Promise<unknown>;
  onDraftChange: (name: string) => void;
}) {
  const [name, setName] = useState(recordPrefixes[category]);
  const [error, setError] = useState("");
  useEffect(() => {
    onDraftChange(name);
  }, [name, onDraftChange]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled) return;
    setError("");
    try {
      await onSubmit(name);
      onClose();
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !disabled) onClose();
      }}
    >
      <DialogContent
        showCloseButton={!disabled}
        onEscapeKeyDown={(event) => {
          if (disabled) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <form onSubmit={(event) => void submit(event)}>
          <DialogHeader>
            <DialogTitle>
              新增 {category === "players" ? "玩家" : dataLabels[category]} 记录
            </DialogTitle>
            <DialogDescription>
              创建后进入 NBT 编辑，保存存档时写入。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup className="py-4">
            <Field data-invalid={!!error}>
              <FieldLabel htmlFor="record-name">记录名称</FieldLabel>
              <Input
                id="record-name"
                value={name}
                autoFocus
                readOnly={category === "portals"}
                disabled={disabled}
                aria-invalid={!!error}
                onChange={(event) => setName(event.target.value)}
              />
              {error ? <FieldError>{error}</FieldError> : null}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" disabled={disabled}>
              {disabled ? "处理中…" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
