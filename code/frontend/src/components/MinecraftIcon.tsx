import type { ImgHTMLAttributes } from "react";
import { minecraftIcon } from "@/lib/minecraft-icons";

export default function MinecraftIcon({
  name,
  className = "",
  ...props
}: ImgHTMLAttributes<HTMLImageElement> & { name: string }) {
  const src = minecraftIcon(name);
  return src ? (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      width={20}
      height={20}
      draggable={false}
      className={`minecraft-icon ${className}`}
      {...props}
    />
  ) : null;
}
