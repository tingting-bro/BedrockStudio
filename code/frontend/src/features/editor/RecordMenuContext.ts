import { createContext } from "react";
import type { RecordCategory } from "@/lib/api";

export const RecordMenuContext = createContext<{
  documentId: string;
  revision: number;
  onCreate: (category: RecordCategory) => void;
  onAddTag: (record: string, tagId: number, records?: string[]) => void;
} | null>(null);
