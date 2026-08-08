import { createWhiteboardHandler } from "@/lib/whiteboard/whiteboard-handler"

/**
 * A drawing turn is a dozen tool round trips, not one — see
 * `WHITEBOARD_MAX_LLM_CALLS`. The chat route's 60s is the floor here too.
 */
export const maxDuration = 60

export const POST = createWhiteboardHandler()
