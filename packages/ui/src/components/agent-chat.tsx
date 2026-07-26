"use client"

import { useMemo } from "react"
import { useChat } from "@ai-sdk/react"
import { DefaultChatTransport, getToolName, isToolUIPart } from "ai"
import { MessageSquareIcon } from "lucide-react"

import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@workspace/ui/components/ai-elements/conversation"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@workspace/ui/components/ai-elements/message"
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@workspace/ui/components/ai-elements/prompt-input"
import { Shimmer } from "@workspace/ui/components/ai-elements/shimmer"
import {
  Suggestion,
  Suggestions,
} from "@workspace/ui/components/ai-elements/suggestion"
import {
  Tool,
  ToolContent,
  ToolHeader,
  ToolInput,
  ToolOutput,
} from "@workspace/ui/components/ai-elements/tool"
import { cn } from "@workspace/ui/lib/utils"

export interface AgentChatProps {
  api?: string
  suggestions?: string[]
  emptyStateTitle?: string
  emptyStateDescription?: string
  placeholder?: string
  className?: string
}

export function AgentChat({
  api = "/api/chat",
  suggestions = [],
  emptyStateTitle = "How can I help?",
  emptyStateDescription = "Ask a question to get started",
  placeholder = "Ask anything…",
  className,
}: AgentChatProps) {
  const transport = useMemo(() => new DefaultChatTransport({ api }), [api])
  const { messages, sendMessage, status, stop } = useChat({ transport })

  const isEmpty = messages.length === 0

  const handleSubmit = (message: PromptInputMessage) => {
    const text = message.text.trim()
    if (!text) return
    void sendMessage({ text })
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <Conversation>
        <ConversationContent>
          {isEmpty ? (
            <ConversationEmptyState
              description={emptyStateDescription}
              icon={<MessageSquareIcon className="size-8" />}
              title={emptyStateTitle}
            />
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, index) => {
                    const key = `${message.id}-${index}`

                    if (part.type === "text") {
                      return (
                        <MessageResponse key={key}>{part.text}</MessageResponse>
                      )
                    }

                    if (part.type === "dynamic-tool") {
                      return (
                        <Tool key={key}>
                          <ToolHeader
                            state={part.state}
                            toolName={part.toolName}
                            type={part.type}
                          />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            <ToolOutput
                              errorText={part.errorText}
                              output={part.output}
                            />
                          </ToolContent>
                        </Tool>
                      )
                    }

                    if (isToolUIPart(part)) {
                      return (
                        <Tool key={key}>
                          <ToolHeader
                            state={part.state}
                            title={getToolName(part)}
                            type={part.type}
                          />
                          <ToolContent>
                            <ToolInput input={part.input} />
                            <ToolOutput
                              errorText={part.errorText}
                              output={part.output}
                            />
                          </ToolContent>
                        </Tool>
                      )
                    }

                    return null
                  })}
                </MessageContent>
              </Message>
            ))
          )}
          {status === "submitted" && <Shimmer>Thinking…</Shimmer>}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="grid shrink-0 gap-2 p-4 pt-2">
        {isEmpty && suggestions.length > 0 && (
          <Suggestions>
            {suggestions.map((suggestion) => (
              <Suggestion
                key={suggestion}
                onClick={(text) => void sendMessage({ text })}
                suggestion={suggestion}
              />
            ))}
          </Suggestions>
        )}
        <PromptInput onSubmit={handleSubmit}>
          <PromptInputBody>
            <PromptInputTextarea placeholder={placeholder} />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit onStop={stop} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}
