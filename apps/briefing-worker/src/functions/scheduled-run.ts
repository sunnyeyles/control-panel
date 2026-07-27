import { app, type InvocationContext, type Timer } from "@azure/functions"

import { runScheduledTask } from "../run-scheduled-task.js"

/**
 * 09:00 UTC, daily. NCRONTAB is `{sec} {min} {hour} {day} {month} {day-of-week}`,
 * and Flex Consumption has no timezone setting, so this is UTC by construction.
 *
 * The cadence lives here rather than in an app setting: changing it is an edit
 * to this line plus a redeploy, which keeps the schedule reviewable in the diff
 * instead of drifting invisibly in portal configuration.
 */
const SCHEDULE = "0 0 9 * * *"

app.timer("scheduledRun", {
  schedule: SCHEDULE,
  handler: async (timer: Timer, context: InvocationContext): Promise<void> => {
    if (timer.isPastDue) {
      context.warn("Timer is past due — this occurrence is running late.")
    }

    // Nothing is caught here on purpose. A throw is the contract: it marks the
    // invocation Failed, which is how a bad run becomes visible at all.
    await runScheduledTask()
  },
})
