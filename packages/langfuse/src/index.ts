import { CallbackHandler } from "@langfuse/langchain"
import { LangfuseSpanProcessor } from "@langfuse/otel"
import {
  propagateAttributes,
  setLangfuseTracerProvider,
  startActiveObservation,
} from "@langfuse/tracing"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

export interface LangfuseCallbackOptions {
  userId?: string
  sessionId?: string
  tags?: string[]
  traceMetadata?: Record<string, string>
}

export interface LangfuseTraceOptions extends LangfuseCallbackOptions {
  name: string
  input: unknown
}

let provider: NodeTracerProvider | undefined

function isConfigured(): boolean {
  return Boolean(
    process.env.LANGFUSE_PUBLIC_KEY?.trim() &&
    process.env.LANGFUSE_SECRET_KEY?.trim()
  )
}

/**
 * Set up one provider for this runtime.
 *
 * It carries only Langfuse's processor. Registering it supplies Node's async
 * context manager, which is what keeps tool and model spans nested below the
 * active workflow while a stream is consumed.
 */
export function initializeLangfuse(options: {
  exportMode: "batched" | "immediate"
}): boolean {
  if (!isConfigured()) return false
  if (provider) return true

  provider = new NodeTracerProvider({
    spanProcessors: [
      new LangfuseSpanProcessor({
        exportMode: options.exportMode,
      }),
    ],
  })
  provider.register()
  setLangfuseTracerProvider(provider)

  return true
}

/**
 * Create a fresh handler for one LangChain run.
 *
 * Handlers retain run state, so sharing one across concurrent requests would
 * mix their traces. The caller gives each invocation its own handler instead.
 */
export function createLangfuseCallback(
  options: LangfuseCallbackOptions = {}
): CallbackHandler | undefined {
  if (!provider) return undefined
  return new CallbackHandler(options)
}

/**
 * Wrap a multi-stage workflow in one Langfuse trace.
 *
 * The callback supplied to `run` is created inside the active trace context,
 * which nests every LangChain generation and tool call below this root.
 */
export async function runWithLangfuseTrace<T>(
  options: LangfuseTraceOptions,
  run: (callback: CallbackHandler | undefined) => Promise<T>
): Promise<T> {
  if (!provider) return run(undefined)

  return startActiveObservation(
    options.name,
    async (trace) =>
      propagateAttributes(
        {
          userId: options.userId,
          sessionId: options.sessionId,
          tags: options.tags,
          metadata: options.traceMetadata,
          traceName: options.name,
        },
        async () => {
          trace.update({
            input: options.input,
            metadata: options.traceMetadata,
          })

          try {
            const result = await run(
              createLangfuseCallback({
                userId: options.userId,
                sessionId: options.sessionId,
                tags: options.tags,
                traceMetadata: options.traceMetadata,
              })
            )
            trace.update({ output: result })
            return result
          } catch (error) {
            trace.update({
              level: "ERROR",
              statusMessage:
                error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        }
      ),
    { asType: "chain" }
  )
}

/**
 * Deliver all queued spans before a short-lived runtime can freeze or exit.
 */
export async function shutdownLangfuse(): Promise<void> {
  if (!provider) return

  const active = provider
  provider = undefined
  setLangfuseTracerProvider(null)
  await active.shutdown()
}
