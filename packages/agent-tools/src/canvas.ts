/**
 * The eight canvas tools — the agent's entire vocabulary for touching a board.
 *
 * The model never generates drawing code, and never computes a layout. It names
 * a semantic shape and a position; the session validates that against the
 * shadow board, does any arithmetic, and records ops. That containment is the
 * point: the surface a bad model call can reach is exactly these eight verbs.
 *
 * **Two channels leave every tool, and they carry different things.** The
 * return value is prose for the model — what happened, or what to do instead.
 * The ops go to the tool runtime's `writer`, which is LangGraph's custom
 * stream, and travel straight to the browser without passing through the model
 * at all. So the canvas updates while the sentence describing it is still being
 * typed, and the coordinates of twelve shapes never cost a token of context.
 *
 * That writer is only populated because `@workspace/agents-core` forwards its
 * node config into `ToolRegistry.dispatch`, and because the run streams in
 * `"custom"` mode. If ops ever stop reaching the canvas while the tools still
 * report success, those are the two wires to check, in that order.
 */

import { tool, type StructuredToolInterface } from "@langchain/core/tools"
import * as z from "zod"

import { renderBoard } from "./board-render.ts"
import type { BoardSession } from "./board-session.ts"
import {
  CANVAS_OP_EVENT,
  DEFAULT_GAP,
  DEFAULT_SHAPE_HEIGHT,
  DEFAULT_SHAPE_WIDTH,
  layoutSchema,
  shapeColorSchema,
  shapeKindSchema,
  type CanvasOpEvent,
} from "./canvas-schema.ts"

/**
 * The slice of LangChain's `ToolRuntime` these tools use.
 *
 * Structural rather than the imported type, so this package keeps its two
 * dependencies and stays usable by any caller — the same reasoning as
 * `ChatModelLike` in the runtime: state the shape you drive, take the
 * implementation from the caller.
 *
 * `writer` is `null` whenever the run is not streaming in `"custom"` mode, and
 * the whole runtime argument is absent when a tool is invoked directly. Both
 * are ordinary, not faults: the mutation still happened and the model still
 * gets its answer — only the browser misses the live update, and the next
 * turn's snapshot repairs that.
 */
interface WriterRuntime {
  writer?: ((chunk: unknown) => void) | null
}

export interface CreateCanvasToolsOptions {
  /** Groups a turn's ops so the browser can undo them as one step. */
  turnId: string
}

const idField = z
  .string()
  .describe(
    'The id of a shape on the board, e.g. "s3". Use an id you were given — read the board rather than guessing one.'
  )

export function createCanvasTools(
  session: BoardSession,
  options: CreateCanvasToolsOptions
): StructuredToolInterface[] {
  /**
   * Run a mutation, then push whatever it recorded to the browser.
   *
   * Flushing here rather than inside the session is what keeps the session
   * ignorant of LangGraph — it accumulates ops, and this decides where they
   * go. One write per tool call, carrying the whole batch, because a dozen
   * moves from one `arrange_shapes` have to land in a single `editor.run()`.
   */
  const withOps =
    <TInput>(mutate: (input: TInput) => string) =>
    (input: TInput, runtime?: WriterRuntime): string => {
      const message = mutate(input)
      const ops = session.flush()
      if (ops.length > 0) {
        const event: CanvasOpEvent = {
          type: CANVAS_OP_EVENT,
          turnId: options.turnId,
          ops,
        }
        runtime?.writer?.(event)
      }
      return message
    }

  const readBoard = tool(
    ({
      scope,
    }: {
      scope?: "all" | "viewport" | "selection"
      detail?: "summary" | "full"
    }) => {
      const shapes = session.shapes()
      const { context } = session

      if (scope === "selection") {
        const selected = new Set(context.selection)
        const subset = shapes.filter((shape) => selected.has(shape.id))
        if (subset.length === 0) {
          return "The user has nothing selected. Ask them to select something, or refer to shapes by their labels."
        }
        return renderBoard({
          shapes: subset,
          connections: session
            .connections()
            .filter((c) => selected.has(c.fromId) || selected.has(c.toId)),
        })
      }

      if (scope === "viewport") {
        const { x, y, w, h } = context.viewport
        const subset = shapes.filter(
          (shape) =>
            shape.x + shape.w >= x &&
            shape.x <= x + w &&
            shape.y + shape.h >= y &&
            shape.y <= y + h
        )
        return renderBoard({
          shapes: subset,
          connections: session.connections(),
          viewport: context.viewport,
          selection: context.selection,
        })
      }

      // "all" — the shadow in full, which is also how the model gets past the
      // viewport cap the request body applied.
      return renderBoard({
        shapes,
        connections: session.connections(),
        selection: context.selection,
        recentEdits: context.recentEdits,
        viewport: context.viewport,
      })
    },
    {
      name: "read_board",
      description:
        "Read what is currently on the board. You are already given the board at the start of each turn, so call this only when you need something that summary left out — the shapes outside the user's view, or the state after your own changes. Returns one line per shape with its id, kind, label, position and size.",
      schema: z.object({
        scope: z
          .enum(["all", "viewport", "selection"])
          .optional()
          .describe(
            'Which shapes to return: "all" for the whole board including anything off screen, "viewport" for what the user can see, "selection" for what they have selected. Defaults to "all".'
          ),
        detail: z
          .enum(["summary", "full"])
          .optional()
          .describe(
            "Reserved for future use; the rendering is the same either way."
          ),
      }),
    }
  )

  const createShape = tool(withOps(session.createShape.bind(session)), {
    name: "create_shape",
    description:
      "Add one shape to the board and get back the id it was given. Positions are page coordinates in pixels: x grows to the right and y grows DOWNWARD, so a shape below another has a larger y. Leave a gap of about 80 between neighbours. Call this once per shape; you do not need to read the board in between.",
    schema: z.object({
      kind: shapeKindSchema.describe(
        'What to draw. Use "rectangle" for services and components, "cloud" for external systems, "diamond" for decisions, "ellipse" for start and end points, "note" for a sticky note, "text" for a bare caption or heading.'
      ),
      x: z
        .number()
        .describe("Left edge, in page coordinates. Larger is further right."),
      y: z
        .number()
        .describe("Top edge, in page coordinates. Larger is further DOWN."),
      w: z
        .number()
        .optional()
        .describe(`Width in pixels. Defaults to ${DEFAULT_SHAPE_WIDTH}.`),
      h: z
        .number()
        .optional()
        .describe(`Height in pixels. Defaults to ${DEFAULT_SHAPE_HEIGHT}.`),
      text: z
        .string()
        .optional()
        .describe(
          "The label inside the shape. Keep it to a few words — a box in a diagram is a name, not a sentence."
        ),
      color: shapeColorSchema
        .optional()
        .describe(
          "Colour of the outline and label. Use it to group related shapes; leave it off for the default."
        ),
    }),
  })

  const updateShape = tool(withOps(session.updateShape.bind(session)), {
    name: "update_shape",
    description:
      "Change an existing shape's label, colour or size in place. To change where it is, use move_shape instead.",
    schema: z.object({
      id: idField,
      text: z.string().optional().describe("Replacement label."),
      color: shapeColorSchema.optional().describe("Replacement colour."),
      w: z.number().optional().describe("Replacement width in pixels."),
      h: z.number().optional().describe("Replacement height in pixels."),
    }),
  })

  const moveShape = tool(withOps(session.moveShape.bind(session)), {
    name: "move_shape",
    description:
      "Move one shape to a new position. x and y are the shape's new top-left corner in page coordinates: increasing x moves it right, and increasing y moves it DOWN. To tidy several shapes at once, use arrange_shapes rather than moving them one by one.",
    schema: z.object({
      id: idField,
      x: z.number().describe("New left edge. Larger is further right."),
      y: z.number().describe("New top edge. Larger is further DOWN."),
    }),
  })

  const deleteShape = tool(
    withOps(({ ids }: { ids: string[] }) => session.deleteShapes(ids)),
    {
      name: "delete_shape",
      description:
        "Remove shapes from the board. Any arrows attached to them go too, and an arrow's own id can be passed here to remove just that arrow. Deleting is not reversible from your side, so only delete what the user asked you to.",
      schema: z.object({
        ids: z
          .array(z.string())
          .min(1)
          .describe('The ids to remove, e.g. ["s3", "s4"].'),
      }),
    }
  )

  const connectShapes = tool(withOps(session.connectShapes.bind(session)), {
    name: "connect_shapes",
    description:
      "Draw an arrow from one shape to another, bound to both so it follows them when either moves. The arrow points from fromId to toId, so put them in the direction the data or control actually flows.",
    schema: z.object({
      fromId: z.string().describe("Id of the shape the arrow starts at."),
      toId: z.string().describe("Id of the shape the arrow points to."),
      label: z
        .string()
        .optional()
        .describe(
          'A couple of words on the arrow, e.g. "writes" or "on failure". Leave it off when the relationship is obvious.'
        ),
    }),
  })

  const arrangeShapes = tool(withOps(session.arrangeShapes.bind(session)), {
    name: "arrange_shapes",
    description:
      "Tidy several shapes into an arrangement — this is how you clean up a diagram. Positions are worked out for you, so prefer this over moving shapes one at a time whenever you want them lined up or evenly spaced.",
    schema: z.object({
      ids: z
        .array(z.string())
        .min(2)
        .describe("The ids to arrange, at least two."),
      layout: layoutSchema.describe(
        'How to arrange them: "row" or "column" to lay them out in order with even gaps, "grid" for a block, "align-*" to line up one edge without changing the other axis, "distribute-*" to even out the space between shapes while leaving the outermost two where they are.'
      ),
      gap: z
        .number()
        .optional()
        .describe(
          `Pixels between neighbours, for row, column and grid. Defaults to ${DEFAULT_GAP}.`
        ),
    }),
  })

  const focusViewport = tool(
    withOps(({ ids }: { ids?: string[] }) => session.focusViewport(ids)),
    {
      name: "focus_viewport",
      description:
        "Scroll and zoom the user's view to fit some shapes. Use it after drawing something new so they can see it, or when pointing out part of a large board. Omit ids to fit the whole board.",
      schema: z.object({
        ids: z
          .array(z.string())
          .optional()
          .describe("Ids to bring into view. Omit to fit everything."),
      }),
    }
  )

  return [
    readBoard,
    createShape,
    updateShape,
    moveShape,
    deleteShape,
    connectShapes,
    arrangeShapes,
    focusViewport,
  ]
}
