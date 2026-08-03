import { initializeLangfuse } from "@workspace/langfuse"

// Long-lived Vercel function instances batch exports in the background, but
// LangChain callbacks must finish before a streamed request's runtime ends.
process.env.LANGCHAIN_CALLBACKS_BACKGROUND ??= "false"
initializeLangfuse({ exportMode: "batched" })
