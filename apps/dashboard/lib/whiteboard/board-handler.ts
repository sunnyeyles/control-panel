import { requireUser } from "@/lib/actions/require-user"
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user"
import { getPrisma } from "@/lib/db"
import { saveBoard } from "@workspace/db"

/**
 * Autosave for the canvas.
 *
 * **A route handler rather than a Server Action, deliberately.** The action
 * contract is `(state, formData) => ActionState` because every other write in
 * the app is somebody pressing a button on a form; this is a debounced
 * background write of a JSON blob no form produced and whose result nothing
 * renders.
 *
 * Nothing here imports Next: the authorization and size branches are exactly
 * what a unit test can cover, and a session is what it cannot produce.
 */

/**
 * Refuse anything larger than this rather than handing it to Postgres.
 *
 * A board of a few hundred shapes is well under a megabyte. Past this the
 * likeliest explanations are a pasted image or a runaway loop, and neither is
 * worth a row — the cost of being wrong is one save skipped, and the next one
 * two seconds later succeeds.
 */
export const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024

export interface BoardHandlerDeps {
  getUser?: () => Promise<CurrentUser>
  save?: (userId: string, snapshot: unknown) => Promise<void>
}

export function createBoardHandler(
  deps: BoardHandlerDeps = {}
): (req: Request) => Promise<Response> {
  const getUser = deps.getUser ?? getCurrentUser
  const save =
    deps.save ??
    (async (userId: string, snapshot: unknown) => {
      await saveBoard(
        getPrisma(),
        userId,
        snapshot as Parameters<typeof saveBoard>[2]
      )
    })

  return async function PUT(req: Request): Promise<Response> {
    const caller = await requireUser(getUser, "whiteboard-board")

    if (!caller.ok) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Measured before parsing. The bytes are unavoidably buffered first, so what
    // this guards is the decode, the parse and the Postgres row. Bytes and not
    // `string.length`: code units under-count multi-byte text by up to 3×, which
    // would let a snapshot through at triple the named limit.
    const buffer = await req.arrayBuffer()
    if (buffer.byteLength > MAX_SNAPSHOT_BYTES) {
      return Response.json({ error: "Board is too large" }, { status: 413 })
    }

    let body: unknown
    try {
      body = JSON.parse(new TextDecoder().decode(buffer))
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    // The snapshot is tldraw's format and is stored opaque — see
    // `packages/db/src/boards.ts`. All this can usefully check is that it is an
    // object rather than a string or a number, which is what a client bug
    // looks like.
    const snapshot = (body as { snapshot?: unknown } | null)?.snapshot
    if (!snapshot || typeof snapshot !== "object") {
      return Response.json({ error: "Invalid request body" }, { status: 400 })
    }

    try {
      await save(caller.userId, snapshot)
    } catch (error) {
      console.error("whiteboard: could not save the board", error)
      return Response.json({ error: "Could not save" }, { status: 500 })
    }

    return new Response(null, { status: 204 })
  }
}
