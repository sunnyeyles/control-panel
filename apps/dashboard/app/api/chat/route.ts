import { toBaseMessages, toUIMessageStream } from "@ai-sdk/langchain"
import { createAssistant } from "@workspace/agents/assistant"
import { createUIMessageStreamResponse, type UIMessage } from "ai"

export const maxDuration = 60

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json()

  // The factory reads OPENAI_API_KEY at construction; fail the request, not the import
  let assistant: ReturnType<typeof createAssistant>
  try {
    assistant = createAssistant()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Agent initialization failed"
    return Response.json({ error: message }, { status: 500 })
  }

  const stream = await assistant.stream(
    { messages: await toBaseMessages(messages) },
    { streamMode: ["values", "messages"] }
  )

  return createUIMessageStreamResponse({ stream: toUIMessageStream(stream) })
}
