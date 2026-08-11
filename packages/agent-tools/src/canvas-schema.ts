/**
 * The whiteboard wire contract: what the browser sends up about the board, and
 * what the agent sends back for the browser to apply.
 *
 * **This module imports zod and nothing else, deliberately.** Both ends of the
 * wire import it — the tools here, and `apps/dashboard/lib/whiteboard/` on the
 * client — so it is the one place the two sides can agree, and a dependency on
 * anything server-shaped (or on tldraw) would make one of them unable to. Every
 * type below is inferred from a schema rather than declared beside one, so a
 * field cannot be added to the type and forgotten in the validation.
 *
 * Two vocabulary decisions run through the whole file:
 *
 * - **Shape kinds are semantic, not tldraw's.** The model asks for a `cloud` or
 *   a `note`; the client decides that means `geo`/`cloud` or `note`. Keeping
 *   tldraw's internals out of the model's vocabulary means the mapping can
 *   change — or the renderer be replaced — without retraining a prompt.
 * - **Ids are the short half of a tldraw id.** A tldraw shape id is
 *   `` `shape:${string}` ``, so `s7` here is `shape:s7` there, and the
 *   conversion is a prefix. No id map exists because none is needed, and none
 *   can therefore fall out of sync.
 */

import * as z from "zod"

/** The prefix tldraw puts on every shape id. See the module note. */
export const TLDRAW_SHAPE_ID_PREFIX = "shape:"

/**
 * What the model may draw.
 *
 * Kept small on purpose: a longer list is a longer prompt and a wider set of
 * near-synonyms for the model to choose badly between. These seven cover box
 * diagrams, which is what "draw the architecture for X" means.
 */
export const shapeKindSchema = z.enum([
  "rectangle",
  "ellipse",
  "diamond",
  "cloud",
  "hexagon",
  "note",
  "text",
])
export type ShapeKind = z.infer<typeof shapeKindSchema>

/**
 * tldraw's own palette names, passed through rather than translated.
 *
 * Colour is the model's only way to group things visually — subsystems, tiers,
 * "the bits that are wrong" — so it is worth exposing, but inventing our own
 * names for the same twelve values would only add a mapping to keep correct.
 */
export const shapeColorSchema = z.enum([
  "black",
  "grey",
  "blue",
  "light-blue",
  "green",
  "light-green",
  "red",
  "light-red",
  "orange",
  "yellow",
  "violet",
  "light-violet",
])
export type ShapeColor = z.infer<typeof shapeColorSchema>

/**
 * The arrangements `arrange_shapes` can produce.
 *
 * The layout maths runs on the server against the shadow board and comes back
 * as ordinary move ops, so the model never computes a coordinate. That is the
 * single biggest quality lever for "clean this diagram up": a model asked for
 * twelve positions will produce eleven good ones and one that overlaps.
 *
 * **`flow-*` is the only pair that reads the arrows**, and it is what "tidy
 * this diagram" should almost always mean. The other seven treat the selection
 * as an unordered bag of boxes, so they can line up a pipeline in the wrong
 * order and be perfectly correct about it; a flow layout ranks the shapes by
 * the connections already on the board, so the arrows come out pointing the way
 * the reader scans. See `graph-layout.ts`.
 */
export const layoutSchema = z.enum([
  "flow-right",
  "flow-down",
  "row",
  "column",
  "grid",
  "align-left",
  "align-right",
  "align-top",
  "align-bottom",
  "distribute-horizontal",
  "distribute-vertical",
])
export type Layout = z.infer<typeof layoutSchema>

/**
 * One shape as the model sees it: position, size, label, colour. No `props`, no
 * `parentId`, no `index`, no `opacity`, no `typeName`. A raw tldraw record is
 * roughly ten times this size and none of the difference is something the model
 * can act on.
 */
const boardShapeSchema = z.object({
  id: z.string(),
  kind: shapeKindSchema,
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  text: z.string().optional(),
  color: shapeColorSchema.optional(),
})
export type BoardShape = z.infer<typeof boardShapeSchema>

/**
 * An arrow between two shapes.
 *
 * Only bound arrows appear here. A loose arrow the user drew between two points
 * connects nothing the model can name, so describing it as a connection would
 * be a lie the model would then reason from.
 */
const boardConnectionSchema = z.object({
  id: z.string(),
  fromId: z.string(),
  toId: z.string(),
  label: z.string().optional(),
})
export type BoardConnection = z.infer<typeof boardConnectionSchema>

const viewportSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
})
export type Viewport = z.infer<typeof viewportSchema>

/**
 * The board, as the browser reports it at the start of one turn.
 *
 * This is the whole of what the server knows about the canvas, and it is
 * re-sent every turn rather than accumulated — which is what keeps the model's
 * context flat as a conversation grows, and what makes any drift self-healing.
 * The four soft-reference fields are the answer to "this box" and "that one
 * over there"; see the whiteboard prompt for how they are used.
 */
export const boardContextSchema = z.object({
  shapes: z.array(boardShapeSchema),
  connections: z.array(boardConnectionSchema),
  /** Ids the user currently has selected. Pointing at something *is* selecting it. */
  selection: z.array(z.string()),
  viewport: viewportSchema,
  /** Ids the *user* created or changed since the last turn — "what I just drew". */
  recentEdits: z.array(z.string()),
  /**
   * A count and bounding box for everything omitted from `shapes` by the
   * viewport cap, so the model knows the board continues past what it was
   * shown rather than concluding the canvas is empty out there.
   */
  offscreen: z
    .object({
      count: z.number(),
      bounds: viewportSchema,
    })
    .optional(),
  /**
   * Ops from the previous turn the browser could not apply, in prose. They ride
   * up a turn late because that is when the model can act on them, and it is
   * how it learns that a shape it moved had already been deleted.
   */
  lastTurnErrors: z.array(z.string()).optional(),
  /**
   * Every id on the canvas, including the ones this board leaves out. For
   * allocation only — the model is never shown it.
   *
   * `shapes` and `connections` are both filtered: by the viewport cap, and by
   * the rule that an arrow is only a connection when both terminals are bound
   * to something visible. Without this list a server allocating `s5` cannot
   * tell that `s5` is a shape it simply was not shown, and tldraw's `store.put`
   * overwrites rather than refuses — so the user loses a shape.
   */
  knownIds: z.array(z.string()).optional(),
})
export type BoardContext = z.infer<typeof boardContextSchema>

/**
 * One canvas mutation, as streamed to the browser.
 *
 * Ops are a separate channel from the assistant's prose: they ride LangGraph's
 * custom stream while the sentence describing them is still being typed, which
 * is why shapes appear as the agent talks rather than after it stops.
 *
 * Note `create` carries a server-allocated `id`. Letting the model invent ids
 * is a known failure source — it reuses them, or refers to one it never made —
 * and allocating from the snapshot means numbering repairs itself each turn.
 */
const canvasOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    id: z.string(),
    kind: shapeKindSchema,
    x: z.number(),
    y: z.number(),
    w: z.number(),
    h: z.number(),
    text: z.string().optional(),
    color: shapeColorSchema.optional(),
  }),
  z.object({
    op: z.literal("update"),
    id: z.string(),
    patch: z.object({
      text: z.string().optional(),
      color: shapeColorSchema.optional(),
      w: z.number().optional(),
      h: z.number().optional(),
    }),
  }),
  z.object({
    op: z.literal("move"),
    id: z.string(),
    x: z.number(),
    y: z.number(),
  }),
  z.object({ op: z.literal("delete"), ids: z.array(z.string()) }),
  z.object({
    op: z.literal("connect"),
    id: z.string(),
    fromId: z.string(),
    toId: z.string(),
    label: z.string().optional(),
  }),
  z.object({ op: z.literal("focus"), ids: z.array(z.string()) }),
])
export type CanvasOp = z.infer<typeof canvasOpSchema>

/**
 * The envelope a tool writes to `config.writer`.
 *
 * Batched rather than one op per write, because `arrange_shapes` produces a
 * dozen moves that must land in a single `editor.run()` — one render, one undo
 * entry. `turnId` is what the client groups an undo stopping point around.
 */
export const CANVAS_OP_EVENT = "canvas-op"

export const canvasOpEventSchema = z.object({
  type: z.literal(CANVAS_OP_EVENT),
  turnId: z.string(),
  ops: z.array(canvasOpSchema),
})
export type CanvasOpEvent = z.infer<typeof canvasOpEventSchema>

/** Default size for a shape the model creates without saying how big. */
export const DEFAULT_SHAPE_WIDTH = 200
export const DEFAULT_SHAPE_HEIGHT = 120

/** Default breathing room between arranged shapes. */
export const DEFAULT_GAP = 80
