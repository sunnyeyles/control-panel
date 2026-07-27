/**
 * What a scheduled run does, and the sole owner of what counts as success.
 *
 * Deliberately separate from the trigger that calls it: the schedule and the
 * Functions binding never change when the task does. Today this is a stub that
 * proves the build-and-run path; next it becomes the proof task, and later the
 * real briefing — each time by replacing this body, not the trigger.
 */
export async function runScheduledTask(): Promise<void> {
  await Promise.resolve()
  console.log("briefing-worker stub task ran")
}
