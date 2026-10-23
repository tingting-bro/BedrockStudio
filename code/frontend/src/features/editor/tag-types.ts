import type { NbtNode } from "@/lib/api";

export const TAG_TYPES = [
  { id: 1, name: "Byte" },
  { id: 2, name: "Short" },
  { id: 3, name: "Int" },
  { id: 4, name: "Long" },
  { id: 5, name: "Float" },
  { id: 6, name: "Double" },
  { id: 8, name: "String" },
  { id: 7, name: "ByteArray" },
  { id: 11, name: "IntArray" },
  { id: 12, name: "LongArray" },
  { id: 10, name: "Compound" },
  { id: 9, name: "List" },
];

export type TagAction =
  | { kind: "add"; node: NbtNode; tagId: number; records?: string[] }
  | { kind: "edit" | "rename" | "delete" | "clear"; node: NbtNode };

export type TagInput = { name: string; value: string; listType: number };
export const isArray = (id: number) => [7, 11, 12].includes(id);
