import type { Findings } from "@workspace/agents"

import type { TraceEvent, TraceSink } from "../trace.ts"

/**
 * A trace, rendered for a person watching it happen.
 *
 * The one sink whose output is meant to be read rather than parsed, which is
 * why it lives under `dev/` and never ships: `dist/` is a deploy root, the
 * bundle's only entry point is `src/index.ts`, and nothing under here is
 * reachable from it.
 *
 * Written to be watched live rather than read afterwards. A step announces
 * itself when it starts, not when it finishes, because the scout routinely
 * takes twenty seconds and a harness that prints nothing for twenty seconds is
 * indistinguishable from one that has hung.
 */

/** Trailing content is cut, not wrapped — a brief is thousands of words. */
const DEFAULT_MAX_LINES = 12
const MAX_LINE_LENGTH = 160
const MAX_ARGS_LENGTH = 160

export interface RenderOptions {
  /** Show every line of every message and tool result. */
  verbose?: boolean
  /** Defaults to `process.stdout`, minus colour when it is not a terminal. */
  write?: (text: string) => void
  color?: boolean
}

type Paint = (text: string) => string

interface Palette {
  dim: Paint
  bold: Paint
  cyan: Paint
  green: Paint
  red: Paint
  yellow: Paint
  magenta: Paint
}

const plain: Paint = (text) => text

/**
 * `NO_COLOR` is honoured because this prints to whatever a developer redirected
 * it into, and escape codes in a saved transcript are noise.
 */
function palette(enabled: boolean): Palette {
  if (!enabled) {
    return {
      dim: plain,
      bold: plain,
      cyan: plain,
      green: plain,
      red: plain,
      yellow: plain,
      magenta: plain,
    }
  }

  const wrap =
    (code: string): Paint =>
    (text) =>
      `\u001b[${code}m${text}\u001b[0m`

  return {
    dim: wrap("2"),
    bold: wrap("1"),
    cyan: wrap("36"),
    green: wrap("32"),
    red: wrap("31"),
    yellow: wrap("33"),
    magenta: wrap("35"),
  }
}

export function createTerminalRenderer(options: RenderOptions = {}): TraceSink {
  const write = options.write ?? ((text: string) => process.stdout.write(text))
  const color =
    options.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR)
  const c = palette(color)
  const maxLines = options.verbose
    ? Number.POSITIVE_INFINITY
    : DEFAULT_MAX_LINES

  const line = (text = "") => write(`${text}\n`)

  /** Indented, truncated, and prefixed — the shape every block of content takes. */
  const block = (text: string, indent: string, paint: Paint = c.dim) => {
    // Nothing to show is not a blank line. A tool result that fits on one line
    // has no remainder, and printing an empty row for it would put a gap in
    // every trace.
    if (!text.trim()) return

    const lines = text.split("\n")
    const shown = lines.slice(0, maxLines)

    for (const one of shown) {
      const cut =
        one.length > MAX_LINE_LENGTH && !options.verbose
          ? `${one.slice(0, MAX_LINE_LENGTH)}…`
          : one
      line(`${indent}${paint(cut)}`)
    }

    if (lines.length > shown.length) {
      line(
        `${indent}${c.dim(`… ${lines.length - shown.length} more line(s) — rerun with --verbose`)}`
      )
    }
  }

  return (event: TraceEvent) => {
    switch (event.type) {
      case "run": {
        if (event.phase === "start") {
          line()
          line(`${c.bold("●")} ${c.bold(event.jobName)}`)
          line(
            c.dim(
              `  job ${short(event.jobId)}   run ${short(event.runId)}   slot ${event.scheduledFor}`
            )
          )
          line()
          return
        }

        line()
        line(
          event.outcome === "success"
            ? `${c.green("✔ success")} ${c.dim(`· ${duration(event.durationMs)}`)}`
            : `${c.red("✘ failed")} ${c.dim(`· ${duration(event.durationMs)}`)}`
        )
        if (event.error) block(event.error, "  ", c.red)
        line()
        return
      }

      case "step": {
        if (event.phase === "start") {
          line(`${c.cyan("▸")} ${c.cyan(event.step)}`)
          return
        }

        const detail = event.detail ? `${event.detail} · ` : ""
        line(c.dim(`  └ ${detail}${duration(event.durationMs)}`))
        return
      }

      case "prompt": {
        line(`  ${c.dim("→ prompt")}`)
        block(event.text, "    ")
        return
      }

      case "message": {
        // A message with only tool calls has no prose worth a heading — the
        // tool lines below say everything it did.
        if (event.text.trim()) {
          line(`  ${c.magenta("✎")} ${c.magenta(event.agent)}`)
          block(event.text, "    ")
        }

        for (const call of event.toolCalls) {
          line(
            `  ${c.yellow("⚙")} ${c.yellow(call.name)} ${c.dim(truncate(JSON.stringify(call.args) ?? "", MAX_ARGS_LENGTH))}`
          )
        }
        return
      }

      case "tool": {
        const head = event.ok ? c.dim("←") : c.red("← error")
        line(`  ${head} ${c.dim(firstLine(event.result))}`)
        block(rest(event.result), "    ")
        return
      }

      case "handoff": {
        line(`  ${c.dim(`⇄ ${postingSummary(event.findings)}`)}`)
        event.findings.postings.forEach((posting, index) => {
          line(
            `    ${c.dim(`${index + 1}.`)} ${posting.title} ${c.dim(`— ${posting.company} (${posting.location})`)}`
          )
          line(`       ${c.dim(posting.url)}`)
        })
        if (event.findings.notes) block(event.findings.notes, "    ")
        return
      }

      case "artifact": {
        line(
          `  ${c.dim(`⇩ ${event.objectKey}`)} ${c.dim(`(${bytes(event.bytes)})`)}`
        )
        return
      }
    }
  }
}

function postingSummary(findings: Findings): string {
  const count = findings.postings.length
  return count === 1 ? "1 posting" : `${count} postings`
}

function short(id: string): string {
  return id.slice(0, 8)
}

function firstLine(text: string): string {
  return truncate(text.split("\n")[0] ?? "", MAX_LINE_LENGTH)
}

function rest(text: string): string {
  return text.split("\n").slice(1).join("\n")
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function duration(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}

function bytes(count: number): string {
  return count < 1024 ? `${count} B` : `${(count / 1024).toFixed(1)} KB`
}
