/**
 * The schema barrel.
 *
 * Table definitions live in sibling files (`./messages.ts`, `./threads.ts`, …)
 * and are re-exported from here. Both the Drizzle client and drizzle-kit read
 * the schema through this one module, so a table that is not re-exported here
 * is invisible to relational queries and to migration generation.
 */

export {}
