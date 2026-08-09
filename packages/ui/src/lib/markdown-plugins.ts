/**
 * Which of Streamdown's expensive plugins a piece of markdown actually needs.
 *
 * String-to-string logic deliberately kept out of the component, for the same
 * reason `markdown.ts` is: everything under `src/components/` needs a DOM to
 * test and nothing here does. What this decides is which of three chunks the
 * chat page fetches — a wrong answer is either a diagram that never renders or
 * a syntax highlighter downloaded to display a sentence — so it is worth being
 * a function with tests rather than three regexes inside a hook.
 */

export type MarkdownPlugin = "code" | "math" | "mermaid"

/**
 * Opening or closing fence, capturing the info string.
 *
 * Global, and therefore stateful: `lastIndex` is reset on entry below. It is
 * module-level rather than built per call because a streaming message is
 * scanned again on every token that arrives (`js-hoist-regexp`).
 */
const FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([^\s`]*)/gm

/**
 * `$$…$$` or `$…$`. Not global — `test` on a global regex advances `lastIndex`
 * and would alternate true/false across calls.
 *
 * The inline form deliberately mirrors remark-math's rule that the content
 * touch both delimiters: a `$` opening one may not be followed by whitespace,
 * and the `$` closing it may not be preceded by any. Without that second half
 * "Between $5 and $10 per month." reads as an equation — which is not a rare
 * shape in an app about job postings, and it would fetch KaTeX on a salary.
 *
 * A `$` inside a code fence still counts, so a message about shell scripts can
 * pull KaTeX it never renders. That is the harmless direction — an unnecessary
 * fetch rather than an equation left as raw text — and separating the two would
 * mean parsing the markdown this is here to avoid parsing.
 */
const MATH_DELIMITER = /\$\$[\s\S]+?\$\$|\$(?![\s$])[^\n$]*[^\s$]\$/

/**
 * A ```` ```mermaid ```` block needs the diagram plugin and **not** the
 * highlighter, which is why fences are paired rather than merely counted: the
 * closing fence of a mermaid block carries no info string, and treating every
 * fence line on its own would read it as a plain code block and fetch shiki to
 * render a diagram.
 *
 * An unclosed fence — the normal state of a message mid-stream — has already
 * contributed its plugin by the time the stream ends.
 */
export function detectMarkdownPlugins(markdown: string): MarkdownPlugin[] {
  const needed = new Set<MarkdownPlugin>()

  FENCE.lastIndex = 0
  let inFence = false
  for (let match = FENCE.exec(markdown); match; match = FENCE.exec(markdown)) {
    if (inFence) {
      inFence = false
      continue
    }
    inFence = true
    needed.add(match[1]?.toLowerCase() === "mermaid" ? "mermaid" : "code")
  }

  if (MATH_DELIMITER.test(markdown)) needed.add("math")

  return [...needed]
}
