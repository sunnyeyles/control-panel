import * as z from "zod"

/**
 * Render a Zod schema as JSON Schema for embedding in a prompt. Derived rather
 * than hand-written so the shape an agent is asked for stays identical to the
 * shape {@link parseJsonAgainstSchema} enforces.
 */
export function schemaDescription(schema: z.ZodType): string {
  return JSON.stringify(z.toJSONSchema(schema), null, 2)
}

/**
 * Models like to wrap JSON in a fenced block despite being asked not to. That
 * is a formatting habit rather than a failure to follow the instruction, so it
 * is stripped rather than rejected — unlike a missing field or a bad URL, which
 * are substantive and do reject.
 */
function stripCodeFence(text: string): string {
  const fenced = text.trim().match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/)
  return (fenced?.[1] ?? text).trim()
}

/**
 * Parse and validate an agent's final message against a Zod schema.
 *
 * Throws rather than degrading. Callers pass producer / schema labels so the
 * error names the right agent without duplicating the parse pipeline.
 */
export function parseJsonAgainstSchema<T>(
  schema: z.ZodType<T>,
  text: string,
  labels: { producer: string; schemaName: string }
): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripCodeFence(text))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `The ${labels.producer}'s final message was not JSON (${message}). It began: ${text.slice(0, 200)}`
    )
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(
      `The ${labels.producer} returned JSON that does not match the ${labels.schemaName} schema: ${z.prettifyError(result.error)}`
    )
  }

  return result.data
}
