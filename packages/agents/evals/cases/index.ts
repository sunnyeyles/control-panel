/**
 * Every case, in the order a report reads best: draw, edit, tidy, refuse, cope,
 * resist.
 *
 * Adding one means adding it to a group file and nothing else — there is no
 * registry to keep in step, in the same spirit as the wildcard subpath exports
 * these packages use.
 */

import type { EvalCase } from "../types.ts"
import { AWARENESS_CASES } from "./awareness.ts"
import { CLEANUP_CASES } from "./cleanup.ts"
import { DRAW_CASES } from "./draw.ts"
import { EDIT_CASES } from "./edit.ts"
import { INJECTION_CASES } from "./injection.ts"
import { RESTRAINT_CASES } from "./restraint.ts"

export const CASES: EvalCase[] = [
  ...DRAW_CASES,
  ...EDIT_CASES,
  ...CLEANUP_CASES,
  ...RESTRAINT_CASES,
  ...AWARENESS_CASES,
  ...INJECTION_CASES,
]
