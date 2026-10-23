import { APP_BRAND, APP_EDITION, APP_CAPTION } from "@/lib/constants";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand">
      <span className="brand-mark">
        <img src="/favicon.svg" alt="" aria-hidden="true" />
      </span>
      <span>
        {APP_BRAND}
        <span className="brand-light"> {APP_EDITION}</span>
      </span>
      {compact ? null : <span className="brand-caption">{APP_CAPTION}</span>}
    </div>
  );
}
