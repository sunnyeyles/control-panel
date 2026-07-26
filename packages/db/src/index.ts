export {
  createDb,
  createPool,
  closeDb,
  getDb,
  type Database,
} from "./client.js"
export { getDatabaseUrl } from "./env.js"
export * as schema from "./schema/index.js"

/**
 * Query helpers are re-exported so consumers can build `where` clauses without
 * taking their own direct dependency on `drizzle-orm`.
 */
export {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  or,
  sql,
} from "drizzle-orm"
