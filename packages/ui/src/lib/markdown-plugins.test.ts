import { describe, expect, it } from "vitest"

import { detectMarkdownPlugins } from "./markdown-plugins"

const detect = (markdown: string) => detectMarkdownPlugins(markdown).sort()

describe("detectMarkdownPlugins", () => {
  it("asks for nothing when the message is prose", () => {
    expect(detect("Hello, here is a plain answer with no markup.")).toEqual([])
    expect(detect("")).toEqual([])
  })

  it("asks for the highlighter on a fenced code block", () => {
    expect(detect("Try:\n\n```js\nconst a = 1\n```\n")).toEqual(["code"])
    expect(detect("Try:\n\n~~~\nplain\n~~~\n")).toEqual(["code"])
  })

  it("treats an indented fence as a fence, up to three spaces", () => {
    expect(detect("   ```py\nx = 1\n   ```\n")).toEqual(["code"])
    expect(detect("    ```py\nx = 1\n")).toEqual([])
  })

  it("asks for the diagram plugin, and not the highlighter, on mermaid", () => {
    expect(detect("```mermaid\ngraph TD;\nA-->B;\n```\n")).toEqual(["mermaid"])
  })

  it("pairs fences, so a closing fence is not read as a second block", () => {
    // The bug this guards: counting fence lines individually reads the closing
    // ``` of a mermaid block as an info-less code block and fetches shiki.
    expect(detect("```mermaid\ngraph TD;\n```\n\nDone.")).toEqual(["mermaid"])
  })

  it("asks for both when a message carries a diagram and real code", () => {
    expect(
      detect("```mermaid\ngraph TD;\n```\n\n```ts\nconst a = 1\n```\n")
    ).toEqual(["code", "mermaid"])
  })

  it("asks for the plugin of an unclosed fence, as a stream produces", () => {
    expect(detect("Here you go:\n\n```ts\nconst a = ")).toEqual(["code"])
    expect(detect("Here you go:\n\n```mermaid\ngraph")).toEqual(["mermaid"])
  })

  it("reads an info string with attributes as its language", () => {
    expect(detect('```ts title="a.ts" {1}\nconst a = 1\n```\n')).toEqual([
      "code",
    ])
  })

  it("asks for KaTeX on either math delimiter", () => {
    expect(detect("The identity $e^{i\\pi} + 1 = 0$ is neat.")).toEqual([
      "math",
    ])
    expect(detect("Displayed:\n\n$$\n\\int_0^1 x\\,dx\n$$\n")).toEqual(["math"])
  })

  it("reads a single-character expression as math", () => {
    expect(detect("Let $x$ be the rate.")).toEqual(["math"])
  })

  it("does not read loose dollar signs as math", () => {
    // Salaries, in an app about job postings. remark-math would not render
    // these either — the `$` closing an expression may not follow whitespace.
    expect(detect("It costs $5 to start.")).toEqual([])
    expect(detect("Between $5 and $10 per month.")).toEqual([])
    expect(detect("Rates: $5, $10, and $15.")).toEqual([])
  })

  it("is stable across calls, despite the global fence regex", () => {
    const markdown = "```js\nconst a = 1\n```\n"
    expect(detect(markdown)).toEqual(["code"])
    expect(detect(markdown)).toEqual(["code"])
    expect(detect(markdown)).toEqual(["code"])
  })
})
