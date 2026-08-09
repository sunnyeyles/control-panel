"use client"

import { cn } from "@workspace/ui/lib/utils"
import type { HTMLAttributes } from "react"

/**
 * The tab-list family of prompt-input parts — plain elements with no library
 * behind them, kept beside the other composer menus rather than in
 * `prompt-input.tsx`, so the whole "parts nobody in this app renders" set lives
 * in one place and the core composer module stays about the composer.
 */

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabsList = ({
  className,
  ...props
}: PromptInputTabsListProps) => <div className={cn(className)} {...props} />

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTab = ({
  className,
  ...props
}: PromptInputTabProps) => <div className={cn(className)} {...props} />

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>

export const PromptInputTabLabel = ({
  className,
  ...props
}: PromptInputTabLabelProps) => (
  // Content provided via children in props
  // oxlint-disable-next-line eslint-plugin-jsx-a11y(heading-has-content)
  <h3
    className={cn(
      "mb-2 px-3 text-xs font-medium text-muted-foreground",
      className
    )}
    {...props}
  />
)

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabBody = ({
  className,
  ...props
}: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
)

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>

export const PromptInputTabItem = ({
  className,
  ...props
}: PromptInputTabItemProps) => (
  <div
    className={cn(
      "flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent",
      className
    )}
    {...props}
  />
)
