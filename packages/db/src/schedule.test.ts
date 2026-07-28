import { describe, expect, it } from "vitest"

import { InvalidScheduleError } from "./errors.ts"
import { computeNextRunAt, isValidSchedule } from "./schedule.ts"

/**
 * Nothing here needs a database, and that is the point: this is where the real
 * bugs live. Every assertion below is about calendar arithmetic across IANA
 * zones, which is exactly the logic a database trigger would have hidden from a
 * test runner.
 */

/** What the local wall clock reads at an instant, for asserting on intent. */
function localTime(instant: Date, timezone: string): string {
  return instant.toLocaleString("sv-SE", { timeZone: timezone })
}

/**
 * The UTC calendar day an instant falls on — `toGeneratedOn()` from
 * `@workspace/user-storage`, restated rather than imported.
 *
 * `@workspace/db` deliberately does not depend on the storage package: an S3
 * key is opaque text to Postgres, which is why `artifacts` has no `kind`
 * column. Importing it here to assert a partition day would draw the arrow this
 * schema exists without.
 */
function utcPartitionDay(instant: Date): string {
  return instant.toISOString().slice(0, 10)
}

describe("computeNextRunAt", () => {
  it("returns the next occurrence strictly after the given instant", () => {
    const next = computeNextRunAt(
      "0 9 * * *",
      "UTC",
      new Date("2026-07-28T08:59:59.999Z")
    )

    expect(next.toISOString()).toBe("2026-07-28T09:00:00.000Z")
  })

  it("does not hand out the slot it was called at", () => {
    // The claim calls this with `now` while `next_run_at` is due, so returning
    // the same instant would let one slot be claimed forever.
    const next = computeNextRunAt(
      "0 9 * * *",
      "UTC",
      new Date("2026-07-28T09:00:00.000Z")
    )

    expect(next.toISOString()).toBe("2026-07-29T09:00:00.000Z")
  })

  describe("daylight saving", () => {
    // Sydney leaves DST at 03:00 on 2026-04-05, when the clock goes back to
    // 02:00 — so 02:30 local happens twice that morning.
    it("runs once, not twice, on the day an hour repeats", () => {
      const beforeTheTransition = new Date("2026-04-03T15:30:00.000Z")

      const first = computeNextRunAt(
        "30 2 * * *",
        "Australia/Sydney",
        beforeTheTransition
      )
      const second = computeNextRunAt("30 2 * * *", "Australia/Sydney", first)

      // 02:30 on the 5th, taken at its first (still-AEDT) occurrence...
      expect(first.toISOString()).toBe("2026-04-04T15:30:00.000Z")
      expect(localTime(first, "Australia/Sydney")).toBe("2026-04-05 02:30:00")

      // ...and the next run is the 6th, not the second 02:30 of the 5th. The
      // repeated hour is an hour of wall clock, not an extra occurrence.
      expect(localTime(second, "Australia/Sydney")).toBe("2026-04-06 02:30:00")
    })

    // Sydney enters DST at 02:00 on 2026-10-04, when the clock jumps to 03:00 —
    // so 02:30 local does not exist that morning.
    it("still runs on the day an hour does not exist", () => {
      const beforeTheTransition = new Date("2026-10-02T16:30:00.000Z")

      const onTheGap = computeNextRunAt(
        "30 2 * * *",
        "Australia/Sydney",
        beforeTheTransition
      )

      // The slot is not skipped — that would silently lose a day's briefing
      // once a year. It lands at the same instant the wall clock would have
      // reached had it not jumped, which reads as 03:30 local.
      expect(onTheGap.toISOString()).toBe("2026-10-03T16:30:00.000Z")
      expect(localTime(onTheGap, "Australia/Sydney")).toBe(
        "2026-10-04 03:30:00"
      )
    })

    it("handles a northern-hemisphere zone the same way", () => {
      // New York enters DST 2026-03-08 (02:30 missing) and leaves it
      // 2026-11-01 (01:30 repeats). Asserted so the behaviour is a property of
      // the library's zone handling, not of one zone's offsets.
      const springForward = computeNextRunAt(
        "30 2 * * *",
        "America/New_York",
        new Date("2026-03-07T07:30:00.000Z")
      )
      expect(localTime(springForward, "America/New_York")).toBe(
        "2026-03-08 03:30:00"
      )

      const fallBack = computeNextRunAt(
        "30 1 * * *",
        "America/New_York",
        new Date("2026-10-31T05:30:00.000Z")
      )
      const dayAfter = computeNextRunAt(
        "30 1 * * *",
        "America/New_York",
        fallBack
      )

      // 01:30 EDT, the first of the two. The second is not a second run.
      expect(fallBack.toISOString()).toBe("2026-11-01T05:30:00.000Z")
      expect(localTime(dayAfter, "America/New_York")).toBe(
        "2026-11-02 01:30:00"
      )
    })

    it("keeps a UTC schedule fixed while a local one moves", () => {
      // The reason `schedule_timezone` defaults to 'UTC': the slot does not
      // move under DST, and it agrees with the timestamps in the run reports.
      const beforeSydneyDst = computeNextRunAt(
        "0 9 * * *",
        "UTC",
        new Date("2026-10-02T12:00:00.000Z")
      )
      const afterSydneyDst = computeNextRunAt(
        "0 9 * * *",
        "UTC",
        new Date("2026-10-06T12:00:00.000Z")
      )

      expect(beforeSydneyDst.toISOString()).toBe("2026-10-03T09:00:00.000Z")
      expect(afterSydneyDst.toISOString()).toBe("2026-10-07T09:00:00.000Z")
    })
  })

  describe("missed slots", () => {
    it("gives one occurrence after a slot missed by hours", () => {
      const missedThisMorning = computeNextRunAt(
        "0 9 * * *",
        "UTC",
        new Date("2026-07-28T14:00:00.000Z")
      )

      expect(missedThisMorning.toISOString()).toBe("2026-07-29T09:00:00.000Z")
    })

    it("gives one occurrence after a slot missed by days, never a backfill", () => {
      // A worker that was off for a week owes one run, not seven. The tick
      // advances `next_run_at` past every missed slot in the claim, which is
      // this call — so what is asserted here is that catching up is not even
      // expressible.
      const outForAWeek = computeNextRunAt(
        "0 9 * * *",
        "UTC",
        new Date("2026-08-04T14:00:00.000Z")
      )

      expect(outForAWeek.toISOString()).toBe("2026-08-05T09:00:00.000Z")
    })

    it("advances only to the next slot of a sub-daily cadence", () => {
      // The hourly tick made sub-daily schedules legal, which is why the
      // occurrence key is an instant rather than a UTC date — a date key would
      // turn the second slot of a day into a constraint violation.
      const morning = new Date("2026-07-28T10:00:00.000Z")
      const evening = computeNextRunAt("0 9,17 * * *", "UTC", morning)
      const nextMorning = computeNextRunAt("0 9,17 * * *", "UTC", evening)

      expect(evening.toISOString()).toBe("2026-07-28T17:00:00.000Z")
      expect(nextMorning.toISOString()).toBe("2026-07-29T09:00:00.000Z")
    })
  })

  describe("the UTC partition day", () => {
    it("files a 09:00 Sydney briefing under the previous calendar date", () => {
      // This looks like a bug and is the specified behaviour, so it is pinned.
      //
      // An S3 key's `YYYY/MM/DD` is derived in UTC on purpose, so a key stays
      // interpretable without its job row — a worker moving region must not
      // start writing to yesterday. A per-job IANA zone then means the two
      // dates legitimately disagree: 09:00 in Sydney is 23:00 UTC the day
      // before.
      //
      // Nothing is lost. The dashboard renders dates from `runs.scheduled_for`;
      // the key is a storage partition, not a date display.
      const scheduledFor = computeNextRunAt(
        "0 9 * * *",
        "Australia/Sydney",
        new Date("2026-07-28T00:00:00.000Z")
      )

      expect(localTime(scheduledFor, "Australia/Sydney")).toBe(
        "2026-07-29 09:00:00"
      )
      expect(utcPartitionDay(scheduledFor)).toBe("2026-07-28")
    })

    it("agrees with the local date for a UTC schedule", () => {
      const scheduledFor = computeNextRunAt(
        "0 9 * * *",
        "UTC",
        new Date("2026-07-28T00:00:00.000Z")
      )

      expect(utcPartitionDay(scheduledFor)).toBe("2026-07-28")
      expect(localTime(scheduledFor, "UTC")).toBe("2026-07-28 09:00:00")
    })
  })

  describe("validation, which is the parse", () => {
    it("rejects an empty expression rather than reading it as every minute", () => {
      // `cron-parser` accepts "" and treats it as a wildcard. A job stored that
      // way would be due at every tick forever, and every tick is a paid run.
      expect(() => computeNextRunAt("", "UTC", new Date())).toThrow(
        InvalidScheduleError
      )
      expect(() => computeNextRunAt("   ", "UTC", new Date())).toThrow(
        InvalidScheduleError
      )
    })

    it("rejects an expression with too few fields", () => {
      expect(() => computeNextRunAt("* * *", "UTC", new Date())).toThrow(
        InvalidScheduleError
      )
    })

    it("rejects an out-of-range field", () => {
      expect(() => computeNextRunAt("99 * * * *", "UTC", new Date())).toThrow(
        InvalidScheduleError
      )
    })

    it("rejects an unknown timezone by name", () => {
      expect(() =>
        computeNextRunAt("0 9 * * *", "Not/AZone", new Date())
      ).toThrow(/is not an IANA timezone name/)
    })

    it("rejects a UTC offset, which cannot survive a DST transition", () => {
      expect(() => computeNextRunAt("0 9 * * *", "+10:00", new Date())).toThrow(
        InvalidScheduleError
      )
    })

    it("rejects an invalid `after`", () => {
      expect(() =>
        computeNextRunAt("0 9 * * *", "UTC", new Date("nonsense"))
      ).toThrow(InvalidScheduleError)
    })

    it("accepts a six-field expression with leading seconds", () => {
      const next = computeNextRunAt(
        "0 0 9 * * *",
        "UTC",
        new Date("2026-07-28T10:00:00.000Z")
      )

      expect(next.toISOString()).toBe("2026-07-29T09:00:00.000Z")
    })
  })
})

describe("isValidSchedule", () => {
  it("is true for a schedule that can produce an occurrence", () => {
    expect(isValidSchedule("0 9 * * *", "Australia/Sydney")).toBe(true)
  })

  it("is false for anything computeNextRunAt would reject", () => {
    expect(isValidSchedule("", "UTC")).toBe(false)
    expect(isValidSchedule("0 9 * * *", "Not/AZone")).toBe(false)
  })
})
