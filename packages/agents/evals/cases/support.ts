/**
 * Building a board for a case to start from.
 *
 * Boards here are written the way the browser would send them, not the way
 * tldraw stores them — `BoardContext` is the wire contract and going through it
 * is what makes a case a real input rather than a convenient fiction.
 */

import type {
  BoardConnection,
  BoardContext,
  BoardShape,
} from "@workspace/agent-tools/canvas-schema"

/** What the browser reports when nothing has been drawn. */
export const VIEWPORT = { x: 0, y: 0, w: 1400, h: 900 }

export function shape(
  id: string,
  text: string,
  x: number,
  y: number,
  overrides: Partial<BoardShape> = {}
): BoardShape {
  return { id, kind: "rectangle", x, y, w: 200, h: 120, text, ...overrides }
}

export function arrow(
  id: string,
  fromId: string,
  toId: string,
  label?: string
): BoardConnection {
  return { id, fromId, toId, ...(label ? { label } : {}) }
}

export function board(overrides: Partial<BoardContext> = {}): BoardContext {
  const shapes = overrides.shapes ?? []
  const connections = overrides.connections ?? []

  return {
    shapes,
    connections,
    selection: [],
    viewport: VIEWPORT,
    recentEdits: [],
    // The client always sends this, and leaving it out would let the session
    // allocate an id that is already on the canvas — the exact bug `knownIds`
    // exists to prevent. A case that omitted it would be testing a board the
    // browser never sends.
    knownIds: [
      ...shapes.map((entry) => entry.id),
      ...connections.map((entry) => entry.id),
    ],
    ...overrides,
  }
}
