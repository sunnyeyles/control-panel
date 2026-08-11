import { cn } from "@workspace/ui/lib/utils"

/**
 * A labelled block of the posting detail panel.
 *
 * A heading per section rather than an undifferentiated stack of paragraphs:
 * the summary, the copied highlights and the reason it matched come from three
 * different places and read as one wall of text without labels.
 */
export function PostingDetailSection({
  title,
  className,
  children,
}: {
  title: string
  /**
   * Extra classes on the `<section>` itself.
   *
   * Exists for one caller: **Where and when** is only on screen below `lg`, and
   * the heading has to disappear with its own content — a `lg:hidden` on the
   * grid inside would leave the parent's `gap-5` and an uppercase heading above
   * nothing.
   */
  className?: string
  children: React.ReactNode
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  )
}
