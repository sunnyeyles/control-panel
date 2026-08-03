import type { Findings } from "@workspace/agents"

/**
 * The **trace**: everything a briefing run did, as it did it.
 *
 * Distinct from the two things that already exist and neither of which replaces
 * it. The **run** is the row — queryable state, three statuses, what a filter
 * runs against. The **run report** is the single JSON line an invocation emits
 * — the outcome, the counts, the object key. The trace is the third thing: the
 * transcript. Every step boundary, every model message, every tool round trip,
 * in order, with the inputs and outputs a person needs to answer "why did it do
 * that".
 *
 * It exists because `.invoke()` throws that transcript away. A run holds the
 * whole exchange in memory and then reduces it to two integers — which is why
 * `countToolResults` in `run-briefing.ts` has to *re-derive* a search count by
 * filtering the finished message array, from data that was observable live.
 *
 * Nothing here writes anywhere. A trace is a stream of events and a
 * {@link TraceSink} is whatever consumes them, so the same run feeds a terminal
 * renderer, a JSON-lines file, an S3 object or an SSE response without knowing
 * which. That is the whole point of the shape: one seam, many renderers, rather
 * than a second logging system per destination.
 */

/** Which agent an event came from. */
export type TraceAgent = "scout" | "writer"

/**
 * The stages of a run, in the order they happen.
 *
 * Named for what they accomplish rather than for the function that does it, so
 * a reader who has never opened `run-briefing.ts` can still follow a trace.
 */
export type TraceStep =
  "config" | "scout" | "handoff" | "writer" | "upload" | "record" | "findings"

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
export type TraceEventBody =
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
  /** Time a step and emit both of its events. Returns whatever `body` returns. */
  step<T>(
    step: TraceStep,
    body: () => Promise<T>,
    detail?: (result: T) => string
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
    detail?: (result: T) => string
  ): Promise<T> {
    emit({ type: "step", phase: "start", step: name })
    const startedAt = Date.now()

    // No catch. A failed step emits no `end`, and that absence is the signal —
    // the run's own `end` event carries the error, and inventing a synthetic
    // "ended, badly" here would put the same fact in two places.
    const result = await body()

    emit({
      type: "step",
      phase: "end",
      step: name,
      durationMs: Date.now() - startedAt,
      ...(detail ? { detail: detail(result) } : {}),
    })

    return result
  }

  return emit
}
