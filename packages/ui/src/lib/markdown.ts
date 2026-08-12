import { marked } from "marked"
import TurndownService from "turndown"

/**
 * Markdown ⇄ HTML for the rich-text editor.
 *
 * ⚠️ **This is where the markdown dialect is pinned, and pinning it is the
 * point of the module.** The editor holds HTML, so every open parses markdown
 * and every save serializes it back — a document that is opened and saved
 * without being touched makes that round trip in full. Turndown's defaults do
 * not agree with the dialect the Letter Writer emits (`_em_` for `*em*`, `*`
 * bullets for `-`, `* * *` for `---`), so on the defaults an untouched save
 * rewrites every line carrying emphasis, a bullet, or a rule.
 *
 * That churn is not cosmetic. A cover letter is one object per Posting, so a
 * save is the whole file, and bytes that differ for no reason are bytes a user
 * cannot tell apart from an edit they made. `markdown.test.ts` asserts the trip
 * is a fixed point over the constructs a letter contains — that test is the
 * guard, not this comment. It lives outside the component so it can be asserted
 * without a DOM.
 *
 * ⚠️ **The trip is a fixed point over the constructs the writers emit, not
 * over all of GFM.** Turndown ships no table rule, so a pipe table in a
 * stored document would come back from an untouched save as its cell text in
 * paragraphs. Nothing emits tables today; a writer that starts to needs a
 * table rule added here — and a case in `markdown.test.ts` — first.
 */

/** Parse stored markdown into the HTML the editor is initialized with. */
export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false })
}

/**
 * A serializer taking the editor's HTML back to markdown.
 *
 * Returned rather than applied, because constructing one is not free and the
 * editor serializes on every file switch, download and save — the caller
 * memoizes it for that reason.
 */
export function createMarkdownSerializer(): TurndownService {
  const serializer = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    // The three that differ from Turndown's defaults, each chosen to match what
    // the Letter Writer emits rather than for its own sake.
    bulletListMarker: "-",
    emDelimiter: "*",
    hr: "---",
  })

  // ⚠️ **The list marker is padded by a rule, not by an option, which is why
  // this override exists at all.** Turndown builds every list item prefix as
  // marker-plus-three-spaces (`-   item`, `1.  item`) and indents continuation
  // lines four, with no option reaching any of it. A letter listing skills —
  // which is most of them — would come back from an untouched save with every
  // bullet re-indented, and `bulletListMarker` alone would have fixed the
  // character and left the padding.
  serializer.addRule("listItem", {
    // `li`, the element — `listItem` is the *key* Turndown files its own rule
    // under, and passing that as the filter silently matches nothing.
    filter: "li",
    replacement: (content, node) => {
      const prefix = listItemPrefix(node)

      const body = content
        .replace(/^\n+/, "")
        .replace(/\n+$/, "\n")
        // Continuation lines and nested lists align under the text, so the
        // indent follows the prefix rather than being fixed at four.
        .replace(/\n/gm, `\n${" ".repeat(prefix.length)}`)

      // Turndown joins items itself; this only closes an item that has a
      // sibling after it and did not already end in a newline.
      return prefix + body + (node.nextSibling && !/\n$/.test(body) ? "\n" : "")
    },
  })

  return serializer
}

/** `- ` in a bullet list, `3. ` in an ordered one — counting as Turndown does. */
function listItemPrefix(node: Node): string {
  const parent = node.parentNode

  if (!parent || parent.nodeName !== "OL") return "- "

  const list = parent as Element
  // `start` absent ⇒ 1, matching both HTML's default and Turndown's own
  // `start ? Number(start) + index : index + 1`. Presence, not truthiness:
  // `marked` emits `start="0"` for a list numbered from zero, and `|| 1`
  // would renumber it on an untouched save.
  const attr = list.getAttribute("start")
  const start = attr ? Number(attr) : 1
  const index = Array.prototype.indexOf.call(list.children, node)

  return `${start + Math.max(index, 0)}. `
}
