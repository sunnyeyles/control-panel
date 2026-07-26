import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import * as z from "zod"

export type AgentTool = StructuredToolInterface

export interface ToolRegistry {
  /** Passed to `model.bindTools()`. */
  tools: AgentTool[]
  /** Lookup used by the tool node to dispatch a tool call. */
  byName: Record<string, AgentTool>
}

/**
 * Index a tool list by name, rejecting duplicates — two tools sharing a name
 * would silently shadow each other at dispatch time.
 */
export function createToolRegistry(tools: AgentTool[]): ToolRegistry {
  const byName: Record<string, AgentTool> = {}

  for (const entry of tools) {
    if (byName[entry.name]) {
      throw new Error(`Duplicate tool name in registry: "${entry.name}"`)
    }
    byName[entry.name] = entry
  }

  return { tools, byName }
}

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

/** Tools the agent gets when the caller does not supply its own. */
export const defaultTools: AgentTool[] = [getCurrentTime]
