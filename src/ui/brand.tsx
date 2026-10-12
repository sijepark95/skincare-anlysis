import Link from "next/link";
import "./brand.css";
export function Brand({ home = "/" }: { home?: string }) {
  return (
    <Link className="brand brand--aelune" href={home} aria-label="AELUNE home">
      <svg viewBox="0 0 44 60" aria-hidden="true">
        <path
          d="M20 1C20 14 4 27 4 39C4 52 13 59 24 57C40 55 43 41 34 26C27 14 22 11 20 1ZM34 28C26 28 16 34 16 44C16 54 26 60 34 52C41 45 39 35 34 28Z"
          fill="currentColor"
          fillRule="evenodd"
        />
      </svg>
      <span>AELUNE</span>
    </Link>
  );
}
