import { jsPDF } from "jspdf"
import { marked, type Token, type Tokens } from "marked"

/**
 * A text-based PDF straight from markdown via jsPDF's native text API. No HTML
 * rasterization: html2canvas proved unreliable across browsers and embedding
 * contexts and could silently produce blank pages. This is deterministic, and
 * the text stays selectable.
 */

// A4 in points
const PAGE_WIDTH = 595.28
const PAGE_HEIGHT = 841.89
const MARGIN_X = 60
const MARGIN_TOP = 64
const MARGIN_BOTTOM = 64
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2

interface InlineRun {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
}

/**
 * Undo the escaping marked applies to text tokens — exactly once.
 *
 * One pass rather than five chained replaces: `&amp;lt;` is an author who wrote
 * a literal `&lt;`, and unescaping `&amp;` first would hand `&lt;` to the next
 * replace, which would turn it into `<`.
 *
 * ⚠️ **Called at the leaves only.** Running it in `flattenInline` over a whole
 * result put already-unescaped runs through a second time, so `&amp;lt;` inside
 * `**bold**` came out as `<`. Nothing below unescapes a run it did not create.
 */
const unescapeEntities = (text: string): string =>
  text.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (match, entity: string) => ENTITIES[entity] ?? match
  )

/** Flatten marked inline tokens into style runs. */
function flattenInline(
  tokens: Token[] | undefined,
  bold = false,
  italic = false
): InlineRun[] {
  if (!tokens) return []
  const runs: InlineRun[] = []
  for (const t of tokens) {
    switch (t.type) {
      case "strong":
        runs.push(...flattenInline((t as Tokens.Strong).tokens, true, italic))
        break
      case "em":
        runs.push(...flattenInline((t as Tokens.Em).tokens, bold, true))
        break
      case "codespan":
        runs.push({
          text: unescapeEntities((t as Tokens.Codespan).text),
          bold,
          italic,
          code: true,
        })
        break
      case "link":
        runs.push(...flattenInline((t as Tokens.Link).tokens, bold, italic))
        break
      case "text": {
        const tt = t as Tokens.Text
        if (tt.tokens && tt.tokens.length > 0) {
          runs.push(...flattenInline(tt.tokens, bold, italic))
        } else {
          runs.push({
            text: unescapeEntities(tt.text),
            bold,
            italic,
            code: false,
          })
        }
        break
      }
      case "br":
        runs.push({ text: "\n", bold, italic, code: false })
        break
      case "escape":
        runs.push({
          text: unescapeEntities((t as Tokens.Escape).text),
          bold,
          italic,
          code: false,
        })
        break
      default:
        if ("text" in t && typeof t.text === "string") {
          runs.push({
            text: unescapeEntities(t.text),
            bold,
            italic,
            code: false,
          })
        }
    }
  }
  return runs
}

class PdfWriter {
  doc: jsPDF
  y = MARGIN_TOP

  constructor() {
    this.doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" })
  }

  ensureRoom(height: number) {
    if (this.y + height > PAGE_HEIGHT - MARGIN_BOTTOM) {
      this.doc.addPage()
      this.y = MARGIN_TOP
    }
  }

  setRunFont(run: InlineRun, size: number) {
    const family = run.code ? "courier" : "helvetica"
    let style = "normal"
    if (run.bold && run.italic) style = "bolditalic"
    else if (run.bold) style = "bold"
    else if (run.italic) style = "italic"
    this.doc.setFont(family, style)
    this.doc.setFontSize(size)
  }

  /** Word-wrap and draw styled runs. Returns nothing; advances this.y. */
  drawRuns(
    runs: InlineRun[],
    size: number,
    lineHeight: number,
    indent = 0,
    color: [number, number, number] = [26, 26, 26]
  ) {
    const maxX = MARGIN_X + CONTENT_WIDTH
    let x = MARGIN_X + indent
    this.doc.setTextColor(...color)
    this.ensureRoom(lineHeight)

    const newline = () => {
      this.y += lineHeight
      this.ensureRoom(lineHeight)
      x = MARGIN_X + indent
    }

    for (const run of runs) {
      this.setRunFont(run, size)
      // Split into words, preserving explicit newlines
      const segments = run.text.split("\n")
      segments.forEach((segment, si) => {
        if (si > 0) newline()
        const words = segment.split(/(\s+)/).filter((w) => w.length > 0)
        for (const word of words) {
          const w = this.doc.getTextWidth(word)
          if (x + w > maxX && x > MARGIN_X + indent) {
            newline()
            if (/^\s+$/.test(word)) continue // don't wrap leading whitespace
          }
          this.doc.text(word, x, this.y)
          x += w
        }
      })
    }
    this.y += lineHeight
  }

  block(tokens: Token[], indent = 0) {
    for (const token of tokens) {
      switch (token.type) {
        case "heading": {
          const t = token as Tokens.Heading
          const sizes: Record<number, number> = {
            1: 24,
            2: 18,
            3: 14.5,
            4: 12.5,
            5: 11.5,
            6: 11,
          }
          const size = sizes[t.depth] ?? 11
          const lh = size * 1.3
          this.y += t.depth <= 2 ? 14 : 10
          this.ensureRoom(lh)
          this.drawRuns(
            flattenInline(t.tokens).map((r) => ({ ...r, bold: true })),
            size,
            lh,
            indent
          )
          this.y += 2
          break
        }
        case "paragraph": {
          const t = token as Tokens.Paragraph
          this.drawRuns(flattenInline(t.tokens), 11, 16, indent)
          this.y += 4
          break
        }
        case "list": {
          const t = token as Tokens.List
          t.items.forEach((item, i) => {
            const marker = t.ordered ? `${(Number(t.start) || 1) + i}.` : "•"
            this.ensureRoom(16)
            this.doc.setFont("helvetica", "normal")
            this.doc.setFontSize(11)
            this.doc.setTextColor(26, 26, 26)
            this.doc.text(marker, MARGIN_X + indent + 4, this.y)
            const markerWidth = 18
            // Render item content indented past the marker
            const saved = this.y
            this.blockListItem(item, indent + markerWidth)
            if (this.y === saved) this.y += 16
          })
          this.y += 4
          break
        }
        case "blockquote": {
          const t = token as Tokens.Blockquote
          const startY = this.y - 11
          this.block(t.tokens, indent + 14)
          // Vertical rule alongside the quote
          this.doc.setDrawColor(180, 180, 180)
          this.doc.setLineWidth(2)
          this.doc.line(
            MARGIN_X + indent + 3,
            startY,
            MARGIN_X + indent + 3,
            this.y - 14
          )
          break
        }
        case "code": {
          const t = token as Tokens.Code
          const lines = t.text.split("\n")
          const lh = 13
          const padding = 8
          const boxHeight = lines.length * lh + padding * 2
          this.ensureRoom(
            Math.min(boxHeight, PAGE_HEIGHT - MARGIN_TOP - MARGIN_BOTTOM)
          )
          this.doc.setFillColor(243, 243, 243)
          const boxTop = this.y - 11
          this.doc.rect(
            MARGIN_X + indent,
            boxTop,
            CONTENT_WIDTH - indent,
            Math.min(boxHeight, PAGE_HEIGHT - MARGIN_BOTTOM - boxTop),
            "F"
          )
          this.doc.setFont("courier", "normal")
          this.doc.setFontSize(9.5)
          this.doc.setTextColor(40, 40, 40)
          this.y += padding - 4
          for (const line of lines) {
            this.ensureRoom(lh)
            this.doc.setFont("courier", "normal")
            this.doc.setFontSize(9.5)
            this.doc.text(line, MARGIN_X + indent + padding, this.y)
            this.y += lh
          }
          this.y += padding
          break
        }
        case "hr":
          this.ensureRoom(20)
          this.doc.setDrawColor(200, 200, 200)
          this.doc.setLineWidth(0.75)
          this.doc.line(
            MARGIN_X,
            this.y - 4,
            MARGIN_X + CONTENT_WIDTH,
            this.y - 4
          )
          this.y += 14
          break
        case "space":
          this.y += 4
          break
        default:
          if ("tokens" in token && Array.isArray(token.tokens)) {
            this.block(token.tokens as Token[], indent)
          } else if ("text" in token && typeof token.text === "string") {
            this.drawRuns(
              [{ text: token.text, bold: false, italic: false, code: false }],
              11,
              16,
              indent
            )
          }
      }
    }
  }

  /** List items contain block tokens; text tokens act as paragraphs. */
  blockListItem(item: Tokens.ListItem, indent: number) {
    for (const token of item.tokens) {
      if (token.type === "text") {
        const t = token as Tokens.Text
        this.drawRuns(flattenInline(t.tokens ?? [t]), 11, 16, indent)
      } else {
        this.block([token], indent)
      }
    }
  }
}

export function exportMarkdownToPdf(markdown: string, filename: string) {
  const tokens = marked.lexer(markdown)
  const writer = new PdfWriter()
  writer.block(tokens)

  // Download via a self-contained data: URI instead of pdf.save().
  // pdf.save() uses a temporary blob: URL, which breaks when the app runs
  // inside a sandboxed preview iframe: the download is intercepted and
  // resolved outside the page context where the blob URL no longer exists,
  // producing an empty file. A data: URI carries the bytes inline.
  const dataUri = writer.doc.output("datauristring", { filename })
  const link = document.createElement("a")
  link.href = dataUri
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
}
