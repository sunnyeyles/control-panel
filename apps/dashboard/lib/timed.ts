/**
 * How long one load took, as a line in the function log.
 *
 * ⚠️ **This exists because production is the only place the numbers are real.**
 * `/jobs` is slow on Vercel and fast locally, and the difference is round trips
 * to Neon and S3 from a serverless instance that may have just cold started. One
 * line per load is what makes "the database, the storage, or the render"
 * answerable after the fact rather than by guessing.
 *
 * Deliberately not OpenTelemetry: a page render is not an agent run, and a span
 * exporter on the request path of every page load would answer what
 * `console.log` answers. If these ever need aggregating rather than reading,
 * that is the moment to change it.
 *
 * **Nothing here imports Next.**
 */

/**
 * Run `work`, log how long it took, and return what it returned.
 *
 * Rejections are timed and re-thrown: a load that failed after eight seconds and
 * one that failed instantly are different problems.
 *
 * ⚠️ **The outcome is `resolved` or `threw`, not `ok` or `failed`.**
 * `redirect()` signals itself by throwing, so a gate sending an anonymous
 * visitor to sign-in arrives here as a rejection — logging that as a failure
 * would claim something broke every time somebody signed out. This module cannot
 * tell the two apart without importing Next, so it reports what it observed.
 *
 * `performance.now()` is monotonic: no negative duration from a clock shift.
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
 * One line, structured enough to grep and filter on in Vercel's log view.
 *
 * `console.log` even for a rejection: whoever catches it reports the failure,
 * and a second line at error level would look like a second incident.
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
