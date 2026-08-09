"use client"

import { cn } from "@workspace/ui/lib/utils"
import type { CSSProperties, ElementType } from "react"
import { memo, useMemo } from "react"

export interface TextShimmerProps {
  children: string
  as?: ElementType
  className?: string
  duration?: number
  spread?: number
}

/**
 * One `background-position` loop, in CSS.
 *
 * This used to be a `motion.span`, and `motion` was a 772 KB dependency the
 * repo pulled in for this component alone — on the chat page, which is the
 * landing page. The keyframe and the `--animate-shimmer` token live in
 * `styles/globals.css`, where the root `CLAUDE.md` says animations belong;
 * `duration` reaches it through `--shimmer-duration` rather than an
 * `animationDuration` of its own, so the whole animation stays one shorthand.
 */
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
  duration = 2,
  spread = 2,
}: TextShimmerProps) => {
  const dynamicSpread = useMemo(
    () => (children?.length ?? 0) * spread,
    [children, spread]
  )

  return (
    <Component>
      <span
        className={cn(
          "relative inline-block animate-shimmer bg-size-[250%_100%,auto] bg-clip-text text-transparent",
          "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))]",
          className
        )}
        style={
          {
            "--spread": `${dynamicSpread}px`,
            "--shimmer-duration": `${duration}s`,
            backgroundImage:
              "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
          } as CSSProperties
        }
      >
        {children}
      </span>
    </Component>
  )
}

export const Shimmer = memo(ShimmerComponent)
