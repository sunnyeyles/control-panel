import {
  createBoardSession,
  type BoardSession,
} from "@workspace/agent-tools/board-session"
import { renderBoardContext } from "@workspace/agent-tools/board-render"
import { createCanvasTools } from "@workspace/agent-tools/canvas"
import type { BoardContext } from "@workspace/agent-tools/canvas-schema"
import {
  createAgent,
  createModel,
  type Agent,
  type AgentTool,
  type CreateAgentOptions,
} from "@workspace/agents-core"

/**
 * The agent that draws.
 *
 * It sits at a whiteboard the user is also drawing on, and it edits that board
 * through eight structured tools rather than by generating any kind of drawing
 * code. What it can do to a canvas is exactly those eight verbs — a containment
 * boundary the prompt cannot talk it out of, in the same spirit as the scout's
 * inability to write anything outside its own run.
 *
 * A factory rather than a ready-made instance, like every agent here: building
 * one constructs a model, which reads `OPENAI_API_KEY` and throws without it.
 * This one is *also* per-request for a second reason — the board it reasons
 * about is baked into its system prompt, so an instance outlives its truth.
 */

/**
 * Non-mini, unlike the rest of the repo, and the diagrams are why.
 *
 * Everything else here reads or summarises text. This one has to hold a spatial
 * model in its head — which of a dozen boxes is left of which, where a new one
 * fits without overlapping, what an unlabelled arrow implies — and then keep
 * that model consistent across ten or more tool calls. The mini model draws
 * boxes on top of each other and loses track of which id it just made.
 */
const WHITEBOARD_MODEL = "gpt-5.4"

/**
 * Enough turns to draw a real diagram.
 *
 * A system architecture is six to ten shapes and as many arrows, and every tool
 * round trip costs a model call. The runtime default of 5 is sized for a
 * question with one round trip, so it would divert a drawing request to `halt`
 * about a third of the way in and leave a half-drawn diagram behind a reply
 * that reads as though it finished.
 */
export const WHITEBOARD_MAX_LLM_CALLS = 24

export const WHITEBOARD_SYSTEM_PROMPT = [
  "You are drawing on a whiteboard alongside the user. They can draw, move and select things at the same time as you, and you both see the same canvas.",
  "",
  "The board is described to you at the start of every turn, and that description is current — you do not need to read the board before acting on it. Call read_board only when you need something the description left out: the shapes outside the user's view, or the state after your own changes part-way through a long edit.",
  "",
  "Coordinates are pixels on an infinite page. x grows to the RIGHT and y grows DOWNWARD, so 'above' means a smaller y and 'below' means a larger one. A shape is positioned by its top-left corner. The usual shape is 200 wide and 120 tall, and neighbours read best about 280 apart horizontally and 200 apart vertically — that leaves room for an arrow between them.",
  "",
  "Draw diagrams so they read the way the system runs: left to right for a pipeline, top to bottom for a hierarchy. Give every box a short label — two or three words, a name rather than a sentence. Connect boxes with connect_shapes rather than by placing them next to each other and hoping the relationship is obvious, and point each arrow the way the data or control actually flows. Label an arrow only when the relationship would otherwise be ambiguous.",
  "",
  "When you want several shapes lined up, evenly spaced or tidied, call arrange_shapes rather than working out each position yourself. It does the arithmetic against the real board and it will not overlap anything. This is what 'clean this diagram up' means: arrange what is there, align what is ragged, and fix labels — not redraw it from scratch and lose what the user made.",
  "",
  "After you add something the user cannot currently see, call focus_viewport so they are looking at it.",
  "",
  'Work out what "this", "that" and "here" refer to from what you are given, in this order: what the user has selected, what they most recently drew, the labels on the shapes, and what is inside their viewport. Selection is the strongest signal — pointing at something on a whiteboard is selecting it. If a reference is genuinely ambiguous, ask which one they mean rather than guessing and editing the wrong shape.',
  "",
  "Never invent a shape id. Every id you use must be one you were given — in the board description, or in the reply from a tool that just created it.",
  "",
  "A tool that answers with a correction rather than a confirmation is telling you what to do next: the id did not exist, or the arguments did not make sense. Read it, fix the call, and carry on. Do not report a failure to the user over something you can simply retry, and do not repeat a call that has already failed the same way twice.",
  "",
  "Say what you are doing in a sentence or two as you go, in plain prose. The user is watching the shapes appear, so do not list coordinates, ids or a step-by-step account of your tool calls — describe the diagram, not the drawing of it.",
  "",
  "When the user asks what is wrong with an architecture, or for your opinion on one, answer in prose. Critiquing is not editing: change the board only if they asked you to, or say what you would change and offer to do it.",
].join("\n")

/**
 * One whiteboard agent, and the board its tools write into.
 *
 * Returned together for the same reason `createJobScout` returns its catalog:
 * the agent alone cannot drive a turn. The caller needs the session too — to
 * seed it from the request, and because the ops the tools recorded are how the
 * browser learns what to draw.
 */
export interface WhiteboardSession {
  agent: Agent
  /** The one-turn shadow board. Discard it when the turn ends. */
  board: BoardSession
}

export interface CreateWhiteboardAgentOptions extends Omit<
  CreateAgentOptions,
  "tools"
> {
  /** The board as the browser reported it, at the start of this turn. */
  context: BoardContext
  /** Groups this turn's ops so the browser can undo them as one step. */
  turnId: string
  /** Appended to the eight canvas tools. */
  extraTools?: AgentTool[]
}

export function createWhiteboardAgent(
  options: CreateWhiteboardAgentOptions
): WhiteboardSession {
  const {
    context,
    turnId,
    extraTools = [],
    model,
    maxLlmCalls = WHITEBOARD_MAX_LLM_CALLS,
    systemPrompt,
    ...rest
  } = options

  const board = createBoardSession(context)

  const agent = createAgent({
    ...rest,
    model: model ?? createModel({ model: WHITEBOARD_MODEL }),
    maxLlmCalls,
    // The board goes into the system prompt, not into the messages, and that
    // is the whole of the context-growth story. A board appended to the
    // conversation would be re-sent on every subsequent turn — one stale
    // snapshot per turn, accumulating, each contradicting the last. Here it is
    // simply the current one, and it costs nothing extra because this agent is
    // built fresh for every request anyway.
    systemPrompt:
      systemPrompt ??
      `${WHITEBOARD_SYSTEM_PROMPT}\n\nThe board right now:\n\n${renderBoardContext(context)}`,
    tools: [...createCanvasTools(board, { turnId }), ...extraTools],
  })

  return { agent, board }
}
