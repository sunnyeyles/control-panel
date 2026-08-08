/**
 * How long one load took, as a line in the function log.
 *
 * ⚠️ **This exists because production is the only place the numbers are real.**
 * `/jobs` is slow on Vercel and fast locally, and the difference is round
 * trips to Neon and S3 from a serverless instance that may have just cold
 * started. A local timing tells you nothing about that, and neither does a
 * test. One line per load in the function log is what makes "the database, the
 * storage, or the render" answerable after the fact rather than by guessing.
 *
 * Deliberately not OpenTelemetry. `@workspace/langfuse` traces agent runs and
 * is wired into `instrumentation-node.ts`; a page render is not an agent run,
 * and putting these on that pipeline would mean a span exporter on the request
 * path of every page load to answer a question `console.log` answers. If these
 * numbers ever need to be aggregated rather than read, that is the moment to
 * change it — not before.
 *
 * **Nothing here imports Next**, so it is usable from the modules under `lib/`
 * that deliberately do not either.
 */

/**
 * Run `work`, log how long it took, and return what it returned.
 *
 * Rejections are timed and re-thrown rather than swallowed: a load that failed
 * after eight seconds and a load that failed instantly are different problems,
 * and the caller's own `try`/`catch` still decides what the user sees.
 *
 * ⚠️ **The outcome is `resolved` or `threw`, not `ok` or `failed`, and the
 * wording is doing work.** `redirect()` in a Next server component signals
 * itself by throwing, so a gate that sends an anonymous visitor to sign-in
 * arrives here as a rejection — and logging that as a failure would put a line
 * in the log claiming something went wrong every time somebody signed out.
 * This module cannot tell the two apart without importing Next, so it reports
 * what it actually observed instead of interpreting it.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic, so a clock
 * adjustment mid-request cannot produce a negative duration.
 */
export async function timed<T>(
  label: string,
  work: () => Promise<T>
): Promise<T> {
  const startedAt = performance.now()

  try {
    const result = await work()
    log(label, startedAt, "resolved")
    return result
  } catch (error) {
    log(label, startedAt, "threw")
    throw error
  }
}

/**
 * One line, structured enough to grep and to filter on in Vercel's log view.
 *
 * `console.log` and not `console.error` even for a rejection: whoever catches
 * it reports the failure itself, and a second line at error level would make a
 * timing look like a second incident.
 */
function log(
  label: string,
  startedAt: number,
  outcome: "resolved" | "threw"
): void {
  console.log(
    `timing ${label} ${Math.round(performance.now() - startedAt)}ms ${outcome}`
  )
}
