/**
 * The board registry, re-exported from where it now lives.
 *
 * The table itself moved down to `@workspace/agent-tools/boards/registry`,
 * beside the specs and search factories it names — see that module for why.
 * This file stays because the *platform's* two uses of it live in this package
 * and read it from here: `postingId` in `posting-id.ts` drops each row's
 * tracking parameters, and `board-fetch.ts` wires `fetchByUrl` to a pasted
 * link. `apps/dashboard/lib/postings/posting-source.ts` imports `boardForHost`
 * through `@workspace/agents/job-boards` and is unaffected by the move.
 *
 * Nothing is added here. A re-export rather than a wrapper, deliberately: a
 * second definition of "which board is this?" is exactly what the single-answer
 * rule in `posting-catalog.ts` exists to prevent.
 */

export {
  boardForHost,
  JOB_BOARDS,
  JOB_SCOUT_SEARCH_TOOL_NAMES,
  type JobBoard,
} from "@workspace/agent-tools/boards/registry"
