"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";

type Variant = "primary" | "secondary" | "ghost";
type Size = "md" | "lg";

interface PopButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  // White text on violet, ink text on amber, ink text on the ghost fill.
  primary: "bg-violet text-white hover:bg-violet active:bg-violet-deep",
  secondary: "bg-amber text-candyink hover:bg-amber",
  ghost: "bg-cloud text-ink hover:bg-cloud-2",
};

const SIZES: Record<Size, string> = {
  md: "px-4 py-3 text-[15px]",
  lg: "px-6 py-3.5 text-base",
};

// The chunky CTA. Squishes into the page on press, grows on hover, spring motion.
export const PopButton = forwardRef<HTMLButtonElement, PopButtonProps>(
  function PopButton(
    { variant = "primary", size = "md", icon, children, className, ...rest },
    ref,
  ) {
    return (
      <button
        ref={ref}
        className={cx(
          "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-chunk border-line border-ink font-body font-extrabold",
          "shadow-pop transition-[transform,box-shadow,background-color] duration-150 ease-spring",
          "hover:-translate-x-px hover:-translate-y-px hover:shadow-pop-lg",
          "active:translate-x-[2px] active:translate-y-[2px] active:shadow-pop-press",
          "disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:translate-x-0 disabled:hover:translate-y-0 disabled:hover:shadow-pop",
          VARIANTS[variant],
          SIZES[size],
          className,
        )}
        {...rest}
      >
        {icon && (
          <span className="grid place-items-center" aria-hidden>
            {icon}
          </span>
        )}
        {children}
      </button>
    );
  },
);
