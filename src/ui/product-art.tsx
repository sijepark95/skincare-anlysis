import type { ProductCategory } from "@/domain";
export function ProductArt({
  category,
  name,
}: {
  category: ProductCategory;
  name: string;
}) {
  return (
    <div
      className={`product-art art-${category}`}
      role="img"
      aria-label={`${name}, illustrative packaging`}
    >
      <span className="bottle">
        <span className="bottle-cap" />
        <span className="bottle-label">
          SENMIVA
          <br />
          <i>
            {category === "lip_color"
              ? "color story"
              : category === "sunscreen"
                ? "daily light"
                : category === "moisturizer"
                  ? "quiet care"
                  : "skin essentials"}
          </i>
        </span>
      </span>
      <span className="bottle-shadow" />
    </div>
  );
}
