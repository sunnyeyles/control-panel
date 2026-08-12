<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Comments

Write short, clear, concise comments — a line or two. Say what is not obvious from the code and why it is that way; do not restate the code, narrate the diff, or argue through rejected alternatives. Long-form background goes in `CLAUDE.md` or a package README, not in the source. Full rule under "Conventions" in `CLAUDE.md`.

# Pull requests

Every pull request uses `.github/pull_request_template.md` — Type, What this does, Why, Changes — and passing `--body` to `gh pr create` does not excuse it. The title is a sentence describing the behaviour that changed, never the branch name. Full rules under "Pull requests" in `CLAUDE.md`.
