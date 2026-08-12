import type { Findings } from "@workspace/agents"

/**
 * The **trace**: everything a briefing run did, as it did it.
 *
 * The third thing, next to the **run** (the row — queryable state) and the **run
 * report** (one JSON line per invocation — outcome, counts, object key): the
 * transcript. Every step boundary, model message and tool round trip, in order,
 * with what a person needs to answer "why did it do that". It exists because
 * `.invoke()` throws that transcript away, reducing the whole exchange to two
 * integers.
 *
 * Nothing here writes anywhere. A {@link TraceSink} is whatever consumes the
 * events, so one run feeds a terminal renderer, a JSON-lines file, an S3 object
 * or an SSE response without knowing which — one seam, many renderers.
 */

/** Which agent an event came from. */
export type TraceAgent = "scout" | "writer"

/**
 * The stages of a run, in the order they happen.
 *
 * Named for what they accomplish rather than for the function that does it, so
 * a reader who has never opened `run-briefing.ts` can still follow a trace.
 */
type TraceStep =
  | "config"
  | "scout"
  | "handoff"
  | "filter"
  | "writer"
  | "upload"
  | "record"
  | "findings"
  | "postings"

/** One tool call, paired with the result it eventually got. */
export interface TraceToolCall {
  name: string
  args: unknown
}

/**
 * An event minus its timestamp — what a call site describes.
 *
 * Split out rather than written as `Omit<TraceEvent, "at">`, which does not
 * survive a union: `Omit` over a union keeps only the keys every member shares,
 * so that spelling collapses the whole thing to `{ type }` and rejects every
 * event that carries a payload.
 */
type TraceEventBody =
  | {
      type: "run"
      phase: "start"
      jobId: string
      jobName: string
      runId: string
      /** The slot, not the wall clock — see `NewBrief.occurrence`. */
      scheduledFor: string
    }
  | {
      type: "run"
      phase: "end"
      outcome: "success" | "failure"
      durationMs: number
      /** Present on failure only. */
      error?: string
    }
  | { type: "step"; phase: "start"; step: TraceStep }
  | {
      type: "step"
      phase: "end"
      step: TraceStep
      durationMs: number
      /** One line a human can read without opening anything else. */
      detail?: string
    }
  /** What an agent was asked. The system prompt is the agent's, not the run's. */
  | { type: "prompt"; agent: TraceAgent; text: string }
  /** What the model said, including any tool calls it asked for. */
  | {
      type: "message"
      agent: TraceAgent
      text: string
      toolCalls: TraceToolCall[]
    }
  /** A tool round trip, correlated back to the call that asked for it. */
  | {
      type: "tool"
      agent: TraceAgent
      name: string
      args: unknown
      result: string
      /** `false` for an error result — which is what proves nothing ran. */
      ok: boolean
    }
  /** The scout↔writer contract, after it validated. */
  | { type: "handoff"; findings: Findings }
  | { type: "artifact"; objectKey: string; bytes: number }

/** A {@link TraceEventBody} with the instant it was emitted. */
export type TraceEvent = TraceEventBody & {
  /** ISO 8601, stamped at emit. */
  at: string
}

/**
 * Where a trace goes.
 *
 * Synchronous and returning nothing, deliberately. A sink is a debugging aid
 * and a run is a paid, at-most-once execution: a sink that could be awaited
 * would be a sink that can stall a run, and one that returned a promise would
 * be one whose rejection goes unhandled. {@link safely} covers the remaining
 * case — a sink that throws.
 */
export type TraceSink = (event: TraceEvent) => void

/**
 * Wrap a sink so it cannot take the run down with it.
 *
 * A broken renderer must not fail a briefing that would otherwise have
 * succeeded — the trade is one-sided, since the run costs money and the sink
 * exists to describe it. The failure is reported once, on stderr, rather than
 * swallowed: a sink that silently stopped emitting would be worse than one that
 * crashed.
 */
function safely(sink: TraceSink): TraceSink {
  let complained = false

  return (event) => {
    try {
      sink(event)
    } catch (error) {
      if (complained) return
      complained = true
      console.error(
        `The trace sink threw and has been ignored for the rest of this run: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
}

/**
 * A sink that stamps `at` for you, so call sites describe *what happened*
 * rather than repeating how to read a clock.
 */
export interface Tracer {
  (event: TraceEventBody): void
  /**
   * Time a step and emit both of its events. Returns whatever `body` returns.
   *
   * `detail` may answer `undefined` as well as be omitted, and the two mean the
   * same thing — no line worth printing. A step that has something to say only
   * sometimes (the hand-off, which reports what it dropped and stays quiet when
   * it dropped nothing) would otherwise have to print a line saying nothing.
   */
  step<T>(
    step: TraceStep,
    body: () => Promise<T>,
    detail?: (result: T) => string | undefined
  ): Promise<T>
}

/**
 * No sink is the production case, and it costs nothing: with nobody watching,
 * an event is never built at all — not stamped, not copied, not passed on.
 */
export function createTracer(sink?: TraceSink): Tracer {
  const guarded = sink && safely(sink)

  const emit = ((event: TraceEventBody) => {
    if (!guarded) return
    guarded({ ...event, at: new Date().toISOString() })
  }) as Tracer

  emit.step = async function step<T>(
    name: TraceStep,
    body: () => Promise<T>,
    detail?: (result: T) => string | undefined
  ): Promise<T> {
    emit({ type: "step", phase: "start", step: name })
    const startedAt = Date.now()

    // No catch. A failed step emits no `end`, and that absence is the signal —
    // the run's own `end` event carries the error, and inventing a synthetic
    // "ended, badly" here would put the same fact in two places.
    const result = await body()
    const line = detail?.(result)

    emit({
      type: "step",
      phase: "end",
      step: name,
      durationMs: Date.now() - startedAt,
      ...(line === undefined ? {} : { detail: line }),
    })

    return result
  }

  return emit
}
