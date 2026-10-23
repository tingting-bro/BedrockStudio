import PixelIcon from "@/components/PixelIcon";
import MinecraftIcon from "@/components/MinecraftIcon";
import type { SVGProps } from "react";
import type { DataCategory } from "@/lib/api";

type IconProps = SVGProps<SVGSVGElement>;
export const dataIcons = {
  maps: (props: IconProps) => PixelIcon({ ...props, kind: "map" }),
  tickingareas: (props: IconProps) => PixelIcon({ ...props, kind: "timer" }),
  structures: (props: IconProps) =>
    MinecraftIcon({
      name: "structure_block",
      className: props.className,
      style: props.style,
    }),
  portals: (props: IconProps) => PixelIcon({ ...props, kind: "portal" }),
  scoreboard: (props: IconProps) => PixelIcon({ ...props, kind: "file" }),
  other: (props: IconProps) => PixelIcon({ ...props, kind: "file" }),
} satisfies Record<
  DataCategory,
  (props: IconProps) => ReturnType<typeof PixelIcon> | null
>;
