import type { SVGProps } from "react";
import MinecraftIcon from "./MinecraftIcon";

const paths = {
  world: "M2 2h12v12H2z M2 2h12v4H2z",
  file: "M3 1h7v2h3v12H3z M5 5h6v2H5z M5 9h6v2H5z",
  folder: "M1 3h5v2h9v9H1z M3 7h10v5H3z",
  map: "M1 2h4v2h6V2h4v12h-4v-2H5v2H1z M5 6h2v4H5z M9 5h2v4H9z",
  player: "M5 1h6v6H5z M3 9h10v6H3z M5 11h6v2H5z",
  portal: "M3 1h10v14H3z M5 3h6v10H5z M7 5h2v6H7z",
  timer: "M6 1h4v2H6z M3 4h10v9H3z M5 6h6v5H5z M7 6h2v3h2v2H7z",
} as const;
export default function PixelIcon({
  kind = "world",
  className = "",
  ...props
}: SVGProps<SVGSVGElement> & { kind?: keyof typeof paths }) {
  if (["world", "player", "map", "portal", "timer"].includes(kind))
    return (
      <MinecraftIcon name={kind} className={className} style={props.style} />
    );
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      shapeRendering="crispEdges"
      className={`pixel-icon ${className}`}
      aria-hidden="true"
      {...props}
    >
      <path d={paths[kind]} fillRule="evenodd" />
    </svg>
  );
}
