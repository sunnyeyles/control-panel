import { DevPrismaError } from "./errors"

/**
 * Let through as `undefined`: `await` inspects `.then`, and throwing on that
 * would break every supported call on its way to succeeding.
 */
const PASS_THROUGH = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "constructor",
  "$on",
  "$extends",
  "$transaction",
])

/**
 * Applied to the models as well as the client: `prisma.job` exists, so the
 * likelier mistake is a missing *method* on a model that is present.
 */
export function guard(
  target: Record<string, unknown>,
  path: string = "prisma"
): object {
  const guarded: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(target)) {
    guarded[key] =
      isPlainObject(value) && !key.startsWith("$")
        ? guard(value, `${path}.${key}`)
        : value
  }

  return new Proxy(guarded, {
    get(model, property) {
      if (typeof property === "symbol" || PASS_THROUGH.has(property)) {
        return Reflect.get(model, property)
      }

      if (!(property in model)) {
        throw new DevPrismaError(
          `${path}.${property}`,
          "Add it to lib/dev/fake-prisma.ts, or the page that needs it will only work against a real database."
        )
      }

      return Reflect.get(model, property)
    },
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && value.constructor === Object
  )
}
