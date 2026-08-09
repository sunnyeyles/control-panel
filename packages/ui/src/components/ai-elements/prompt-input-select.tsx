"use client"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"
import type { ComponentProps } from "react"

/**
 * The `<Select>` family of prompt-input parts — a model picker, a mode switch,
 * anything chosen from a list inside the composer.
 *
 * A sibling file rather than more of `prompt-input.tsx` because these are the
 * only thing in that module that reaches Radix's Select, and every page that
 * renders a composer was paying for it whether or not it rendered one of these.
 * The package's export map is one file per subpath, so this is importable as
 * `@workspace/ui/components/ai-elements/prompt-input-select` with no config
 * change.
 */

export type PromptInputSelectProps = ComponentProps<typeof Select>

export const PromptInputSelect = (props: PromptInputSelectProps) => (
  <Select {...props} />
)

export type PromptInputSelectTriggerProps = ComponentProps<typeof SelectTrigger>

export const PromptInputSelectTrigger = ({
  className,
  ...props
}: PromptInputSelectTriggerProps) => (
  <SelectTrigger
    className={cn(
      "border-none bg-transparent font-medium text-muted-foreground shadow-none transition-colors",
      "hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
      className
    )}
    {...props}
  />
)

export type PromptInputSelectContentProps = ComponentProps<typeof SelectContent>

export const PromptInputSelectContent = ({
  className,
  ...props
}: PromptInputSelectContentProps) => (
  <SelectContent className={cn(className)} {...props} />
)

export type PromptInputSelectItemProps = ComponentProps<typeof SelectItem>

export const PromptInputSelectItem = ({
  className,
  ...props
}: PromptInputSelectItemProps) => (
  <SelectItem className={cn(className)} {...props} />
)

export type PromptInputSelectValueProps = ComponentProps<typeof SelectValue>

export const PromptInputSelectValue = ({
  className,
  ...props
}: PromptInputSelectValueProps) => (
  <SelectValue className={cn(className)} {...props} />
)
