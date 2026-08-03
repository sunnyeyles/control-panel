/**
 * Next calls this once before the server accepts requests. Keep the Node-only
 * implementation out of the Edge bundle: Langfuse's exporter uses Node APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node")
  }
}
