/**
 * The board, as prose for the model.
 *
 * One renderer, two callers: the whiteboard prompt renders the snapshot the
 * turn started from, and `read_board` renders the shadow as it stands after
 * whatever the agent has already done. Sharing it means the board never
 * describes itself two different ways within one turn, which is exactly the
 * kind of inconsistency a model resolves by guessing.
 *
 * Line-per-shape rather than JSON, and for a concrete reason: JSON spends
 * roughly a third of its tokens on punctuation the model gains nothing from,
 * and the fixed column order here — id, kind, label, position, size, colour —
 * is easier to compare down a column than a sequence of objects is.
 */

import type {
  BoardConnection,
  BoardContext,
  BoardShape,
  Viewport,
} from "./canvas-schema.ts"

export interface RenderBoardInput {
  shapes: BoardShape[]
  connections: BoardConnection[]
  selection?: string[]
  viewport?: Viewport
  recentEdits?: string[]
  offscreen?: BoardContext["offscreen"]
  lastTurnErrors?: string[]
}

function renderShape(shape: BoardShape): string {
  const label = shape.text ? ` "${shape.text}"` : ""
  const color = shape.color ? ` ${shape.color}` : ""
  return `  ${shape.id} ${shape.kind}${label} at (${shape.x}, ${shape.y}) ${shape.w}x${shape.h}${color}`
}

function renderConnection(connection: BoardConnection): string {
  const label = connection.label ? ` "${connection.label}"` : ""
  return `  ${connection.id}: ${connection.fromId} -> ${connection.toId}${label}`
}

function renderViewport(viewport: Viewport): string {
  return `(${viewport.x}, ${viewport.y}) ${viewport.w}x${viewport.h}`
}

export function renderBoard(input: RenderBoardInput): string {
  const { shapes, connections } = input
  const lines: string[] = []

  if (shapes.length === 0 && connections.length === 0) {
    lines.push("The board is empty.")
  } else {
    lines.push(
      `Board: ${shapes.length} shape(s), ${connections.length} connection(s).`
    )
  }

  if (shapes.length > 0) {
    lines.push("Shapes:", ...shapes.map(renderShape))
  }
  if (connections.length > 0) {
    lines.push("Connections:", ...connections.map(renderConnection))
  }

  // The four reference signals. Each is stated only when it says something —
  // an empty "Selected:" line reads as a fact about the user's attention and
  // is really just an absent one.
  if (input.selection && input.selection.length > 0) {
    lines.push(
      `The user has selected: ${input.selection.join(", ")}. When they say "this" or "that", they almost certainly mean this.`
    )
  }
  if (input.recentEdits && input.recentEdits.length > 0) {
    lines.push(
      `The user just drew or changed: ${input.recentEdits.join(", ")}. This is what "what I just drew" refers to.`
    )
  }
  if (input.viewport) {
    lines.push(`The user is looking at ${renderViewport(input.viewport)}.`)
  }
  if (input.offscreen && input.offscreen.count > 0) {
    lines.push(
      `${input.offscreen.count} further shape(s) lie outside that area, within ${renderViewport(input.offscreen.bounds)}, and are not listed above. Call read_board with scope "all" if you need them.`
    )
  }
  if (input.lastTurnErrors && input.lastTurnErrors.length > 0) {
    lines.push(
      "Some changes from your last turn did not take effect:",
      ...input.lastTurnErrors.map((error) => `  ${error}`)
    )
  }

  return lines.join("\n")
}

/** Render the snapshot a turn started from. Thin, but it names the intent. */
export function renderBoardContext(context: BoardContext): string {
  return renderBoard(context)
}
