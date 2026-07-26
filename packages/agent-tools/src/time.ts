import { tool } from "@langchain/core/tools"
import * as z from "zod"

/**
 * Wall-clock lookup. The model has no reliable sense of "now", so anything
 * date-relative ("this week", "overdue") needs this first.
 */
export const getCurrentTime = tool(
  ({ timeZone }: { timeZone: string }) => {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(new Date())
    } catch {
      return `"${timeZone}" is not a valid IANA time zone. Try e.g. "Australia/Sydney" or "UTC".`
    }
  },
  {
    name: "get_current_time",
    description:
      "Get the current date and time in a given IANA time zone. Call this before answering anything that depends on the present moment.",
    schema: z.object({
      timeZone: z
        .string()
        .describe('IANA time zone name, e.g. "Australia/Sydney" or "UTC".'),
    }),
  }
)
