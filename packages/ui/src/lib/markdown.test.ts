import { describe, expect, it } from "vitest"

// Extensionless: this package overrides to `Bundler` resolution, so nothing is
// rewritten on the way out and the `.ts` specifier the NodeNext workspaces
// carry would not resolve here.
import { createMarkdownSerializer, markdownToHtml } from "./markdown"

/**
 * The markdown dialect the editor round-trips through.
 *
 * ⚠️ **The property under test is that the round trip is a fixed point**, not
 * that any particular delimiter is chosen. The editor holds HTML, so opening a
 * stored letter parses it and saving serializes it back; a letter opened and
 * saved untouched therefore makes the whole trip. Anything the trip does not
 * preserve is a diff in the user's stored letter that no one asked for, and
 * `saveCoverLetter` normalizing line endings — the one place this was thought
 * about — only ever addressed the smallest version of it.
 *
 * Asserted against real `marked` and real `turndown` rather than a stub,
 * because the thing that can break is precisely their default options: this
 * suite fails if a future version changes one, which is the whole reason the
 * dialect is pinned in `markdown.ts` rather than left to them.
 *
 * The editor itself is not in the loop here. ProseMirror preserves the block
 * and mark structure of everything below — that is what the StarterKit schema
 * covers — so the string-to-string trip is the part that can silently drift.
 */

/** Serialize as the editor does, then compare against what was parsed. */
function roundTrip(markdown: string): string {
  return createMarkdownSerializer().turndown(markdownToHtml(markdown))
}

describe("the markdown round trip", () => {
  // Each case is a construct the Letter Writer actually emits, and each one
  // moved under Turndown's defaults: `*em*` became `_em_`, `-` bullets became
  // `*`, and `---` became `* * *`.
  it.each([
    ["a paragraph", "Dear Hiring Team,\n\nI would like to apply."],
    ["emphasis", "I am applying for the *Backend Engineer* role."],
    ["strong emphasis", "My **strengths** are listed below."],
    ["a bullet list", "- Node and Postgres\n- Terraform on AWS"],
    ["an ordered list", "1. Node and Postgres\n2. Terraform on AWS"],
    ["an ordered list that does not start at one", "3. Third\n4. Fourth"],
    ["a nested list", "- Backend\n  - Node\n  - Postgres\n- Infrastructure"],
    ["an ATX heading", "## Why this role"],
    ["a thematic break", "Sincerely,\n\n---\n\nAlice"],
    ["a link", "See [my portfolio](https://example.com)."],
    ["a blockquote", "> The role calls for payments experience."],
  ])("leaves %s exactly as it was", (_case, markdown) => {
    expect(roundTrip(markdown)).toBe(markdown)
  })

  it("leaves a whole letter unchanged, so an untouched save is not a diff", () => {
    // The assertion the suite exists for. Saving without editing must produce
    // the bytes that were opened — otherwise the stored letter changes for no
    // reason a user can see, and a real edit becomes impossible to spot.
    const letter = [
      "Dear Hiring Team,",
      "",
      "I am applying for the *Backend Engineer* role. My **strengths**:",
      "",
      "- Node and Postgres",
      "- Terraform on AWS",
      "",
      "---",
      "",
      "Sincerely,",
      "",
      "Alice",
    ].join("\n")

    expect(roundTrip(letter)).toBe(letter)
  })

  it("emits LF, never CRLF", () => {
    // Implied by the fixed-point cases above — LF in, identical out — but
    // asserted separately because `saveCoverLetter` normalizes CRLF and its
    // comment has twice named a wrong source for it. This is the half that is
    // this package's to answer for: whatever else reaches that action, it is
    // not the serializer.
    expect(roundTrip("A line.\n\nAnother line.")).not.toMatch(/\r/)
  })
})
