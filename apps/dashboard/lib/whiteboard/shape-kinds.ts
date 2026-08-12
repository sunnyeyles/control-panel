import type { ShapeKind } from "@workspace/whiteboard-schema"

/**
 * The one place the agent's vocabulary meets tldraw's.
 *
 * The model says `cloud`; tldraw wants a `geo` shape whose `props.geo` is
 * `"cloud"`. Keeping that translation here — rather than teaching the model
 * tldraw's own type names — means the mapping can change, or the renderer be
 * swapped, without touching a prompt or a tool schema. It is also the reason
 * the wire contract in `@workspace/whiteboard-schema` can stay free of
 * any tldraw import: neither side of it knows this file exists.
 *
 * Five of the seven kinds are the same tldraw shape type with a different
 * `geo` prop. `note` and `text` are genuinely different shapes, and they are
 * also the two that do not take a width and a height — a note is sized by its
 * style and its content, and a text shape has a width but grows its own
 * height. Ops still carry `w`/`h` for them, and this is where those are
 * dropped rather than at every call site.
 */

/** The `geo` value for each kind that renders as a tldraw `geo` shape. */
const GEO_KINDS = {
  rectangle: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
  cloud: "cloud",
  hexagon: "hexagon",
} as const satisfies Partial<Record<ShapeKind, string>>

type GeoKind = keyof typeof GEO_KINDS

export function isGeoKind(kind: ShapeKind): kind is GeoKind {
  return kind in GEO_KINDS
}

export function geoValueFor(kind: GeoKind): (typeof GEO_KINDS)[GeoKind] {
  return GEO_KINDS[kind]
}

/** The tldraw shape type a kind renders as. */
export function shapeTypeFor(kind: ShapeKind): "geo" | "note" | "text" {
  if (isGeoKind(kind)) return "geo"
  return kind
}

/**
 * The reverse trip, for describing the user's own drawings back to the model.
 *
 * `geo` values the vocabulary has no word for — `star`, `heart`, `trapezoid`
 * and the rest — collapse to `rectangle`. That is a deliberate lie of the
 * smallest kind available: the model needs *something* it can reason about
 * spatially, the position and size are exact, and inventing a word it was
 * never taught would be worse. Its label, which is what the model actually
 * reasons from, is unaffected.
 */
export function kindForShape(type: string, geo: unknown): ShapeKind {
  if (type === "note") return "note"
  if (type === "text") return "text"
  if (typeof geo === "string" && geo in GEO_KINDS) return geo as GeoKind
  return "rectangle"
}
