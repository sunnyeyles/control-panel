import { describe, expect, it } from "vitest"

import {
  describeInterval,
  fromCron,
  INTERVAL_HOURS,
  isIntervalHours,
  toCron,
} from "./interval"

describe("toCron", () => {
  it("emits five fields with the minute pinned to zero", () => {
    // The load-bearing property. The tick is hourly on the hour, so an
    // expression with a non-zero minute would describe a slot that waits.
    for (const hours of INTERVAL_HOURS) {
      const fields = toCron(hours).split(" ")

      expect(fields).toHaveLength(5)
      expect(fields[0]).toBe("0")
    }
  })

  it("maps each interval to its canonical expression", () => {
    expect(toCron(1)).toBe("0 * * * *")
    expect(toCron(3)).toBe("0 */3 * * *")
    expect(toCron(12)).toBe("0 */12 * * *")
    expect(toCron(24)).toBe("0 0 * * *")
  })
})

describe("fromCron", () => {
  it("round-trips every interval", () => {
    for (const hours of INTERVAL_HOURS) {
      expect(fromCron(toCron(hours))).toBe(hours)
    }
  })

  it("recognises equivalent spellings it does not itself write", () => {
    // Read-tolerant, write-canonical: a row spelled either way is hourly.
    expect(fromCron("0 */1 * * *")).toBe(1)
    expect(fromCron("0 */24 * * *")).toBe(24)
  })

  it("tolerates irregular whitespace", () => {
    expect(fromCron("  0   */3   *  *  * ")).toBe(3)
  })

  it.each([
    ["a time of day", "0 9 * * *"],
    ["a weekday filter", "0 9 * * 1-5"],
    ["a day of month and month", "0 3 1 1 *"],
    ["a step the picker does not offer", "0 */5 * * *"],
    ["a non-zero minute", "30 * * * *"],
    ["six fields with seconds", "0 0 9 * * *"],
    ["nonsense", "not a cron at all"],
    ["an empty string", ""],
  ])("returns undefined for %s", (_label, cron) => {
    // Guessing would be worse than admitting it: the card shows the stored
    // expression instead of a picker value that disagrees with the database.
    expect(fromCron(cron)).toBeUndefined()
  })

  it("never throws, whatever it is handed", () => {
    for (const cron of ["", "   ", "*", "* * * * * * *"]) {
      expect(() => fromCron(cron)).not.toThrow()
    }
  })
})

describe("isIntervalHours", () => {
  it("accepts the offered intervals and nothing else", () => {
    for (const hours of INTERVAL_HOURS)
      expect(isIntervalHours(hours)).toBe(true)

    for (const value of [0, 2, 5, 23, 25, -1, 1.5, NaN, "3", null, undefined]) {
      expect(isIntervalHours(value)).toBe(false)
    }
  })
})

describe("describeInterval", () => {
  it("reads naturally at every interval", () => {
    expect(describeInterval(1)).toBe("Every hour")
    expect(describeInterval(3)).toBe("Every 3 hours")
    expect(describeInterval(12)).toBe("Every 12 hours")
    expect(describeInterval(24)).toBe("Every 24 hours")
  })
})
