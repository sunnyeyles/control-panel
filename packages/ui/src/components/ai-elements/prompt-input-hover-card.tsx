"use client"

import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@workspace/ui/components/hover-card"
import type { ComponentProps } from "react"

/**
 * The hover-card family of prompt-input parts.
 *
 * Split out of `prompt-input.tsx` for the same reason as the select and command
 * families: Radix's HoverCard was in the chat page's first-load chunk purely
 * because these three wrappers sat in the same module as `PromptInput`, and
 * nothing in this app renders them.
 */

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>

export const PromptInputHoverCard = ({
  openDelay = 0,
  closeDelay = 0,
  ...props
}: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
)

export type PromptInputHoverCardTriggerProps = ComponentProps<
  typeof HoverCardTrigger
>

export const PromptInputHoverCardTrigger = (
  props: PromptInputHoverCardTriggerProps
) => <HoverCardTrigger {...props} />

export type PromptInputHoverCardContentProps = ComponentProps<
  typeof HoverCardContent
>

export const PromptInputHoverCardContent = ({
  align = "start",
  ...props
}: PromptInputHoverCardContentProps) => (
  <HoverCardContent align={align} {...props} />
)
