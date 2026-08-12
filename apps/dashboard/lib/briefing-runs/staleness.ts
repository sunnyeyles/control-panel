/**
 * When a run that still says `running` has stopped being believable.
 *
 * Nothing reaps a run, so a worker that died mid-run leaves the row saying
 * `running` forever. Without a bound the one-run-at-a-time guard would refuse
 * that briefing for good, behind a spinner nobody can clear.
 *
 * ⚠️ Fifteen minutes, against a Lambda timeout of 600s. **If that timeout is
 * raised, raise this with it** — a stale threshold below the timeout would let a
 * second run start while the first was still going, which is a paid duplicate.
 *
 * A read-time judgement rather than a background sweep: a reaper is a second
 * thing that can fail, and nothing here needs the row corrected, only
 * interpreted.
 */
export const RUN_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * The earliest start time a `running` row can have and still be believed.
 *
 * Phrased as a lower bound rather than a predicate because that is what a query
 * wants — `startedAt >= staleBefore(now)` reaches an index, where a computed
 * age cannot.
 */
export function staleBefore(now: Date): Date {
  return new Date(now.getTime() - RUN_STALE_AFTER_MS)
}

/** Whether a run that says `running` started long enough ago to disbelieve. */
export function isStale(startedAt: Date, now: Date): boolean {
  return startedAt.getTime() < staleBefore(now).getTime()
}
