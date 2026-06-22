import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

interface StickerCardProps extends HTMLAttributes<HTMLDivElement> {
  /** Slight playful tilt, like a sticker stuck on the page. */
  tilt?: "left" | "right" | "none";
  /** Lift on hover (use for clickable cards). */
  interactive?: boolean;
  /** Inner panel tone. */
  inset?: boolean;
  children: ReactNode;
}

const TILT: Record<NonNullable<StickerCardProps["tilt"]>, string> = {
  left: "-rotate-1",
  right: "rotate-1",
  none: "",
};

// The outlined sticker surface: cloud fill, ink outline, chunky radius, pop shadow.
export const StickerCard = forwardRef<HTMLDivElement, StickerCardProps>(
  function StickerCard(
    { tilt = "none", interactive = false, inset = false, children, className, ...rest },
    ref,
  ) {
    return (
      <div
        ref={ref}
        className={cx(
          "rounded-chunk-lg border-line border-ink shadow-pop",
          inset ? "bg-cloud-2" : "bg-cloud",
          TILT[tilt],
          interactive &&
            "transition-[transform,box-shadow] duration-150 ease-spring hover:-translate-y-0.5 hover:shadow-pop-lg",
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    );
  },
);
