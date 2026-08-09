import {
  createAgent,
  type Agent,
  type CreateAgentOptions,
} from "@workspace/agents-core"

const BRIEF_WRITER_SYSTEM_PROMPT = [
  "You turn a set of job findings into a short markdown brief for the candidate who asked for it.",
  "",
  "Structure: open with a one-paragraph summary of what the search turned up. Then one section per posting, strongest match first, with the role title and company as the heading. Under each, say what the role is, why it fits, and link the posting. Close with any notes the search itself produced.",
  "",
  "Link every posting using the exact URL in its finding. Do not shorten, rewrite, or reconstruct a URL.",
  "",
  "Write only from the findings you are given. You have no way to look anything up, so anything not in them is something you do not know — do not fill a gap with a plausible salary, a company description, or a deadline.",
  "",
  "If the findings are empty, say so plainly in a couple of sentences and stop. A short honest brief is the correct output; padding it is not.",
  "",
  "Return the markdown itself — no code fence around it, no preamble, no sign-off.",
].join("\n")

export type CreateBriefWriterOptions = Omit<CreateAgentOptions, "tools">

/**
 * The writer: composes the brief, and can do nothing else.
 *
 * It is given no tools at all, which is the point. It cannot search, so it
 * cannot quietly supplement thin findings with something it half-remembers; it
 * cannot write anywhere, so uploading stays the worker's job. What reaches the
 * candidate is exactly what the scout found, rendered.
 */
export function createBriefWriter(
  options: CreateBriefWriterOptions = {}
): Agent {
  const { systemPrompt = BRIEF_WRITER_SYSTEM_PROMPT, ...rest } = options

  return createAgent({ ...rest, systemPrompt, tools: [] })
}
