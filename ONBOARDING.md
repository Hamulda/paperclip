# Welcome to Paperclip

## How We Use Claude

Based on Vojtech Hamada's usage over the last 30 days:

Work Type Breakdown:
  Improve Quality  ████████████░░░░░░░░  58%
  Build Feature    █████░░░░░░░░░░░░░░░  24%
  Debug Fix        ██░░░░░░░░░░░░░░░░░░  12%
  Plan / Design    █░░░░░░░░░░░░░░░░░░░   6%

Top Skills & Commands:
  /clear   ████████████████████  45x/month
  /effort  ███░░░░░░░░░░░░░░░░░   6x/month

Top MCP Servers:
  ripgrep           ██████████░░░░░░░░░░  3 calls
  CodeGraphContext  ██████████░░░░░░░░░░  3 calls

## Your Setup Checklist

### Codebases
- [ ] paperclip — https://github.com/hamulda/paperclip

### MCP Servers to Activate
- [ ] ripgrep — Fast regex/text search across the codebase. Ships with most Claude Code setups; verify it appears in your MCP server list under Settings.
- [ ] CodeGraphContext — Semantic code-graph queries (call chains, dead code, complexity). Ask Vojtech for the server config — it requires a local graph index to be built first.

### Skills to Know About
- `/effort` — Bumps Claude to maximum reasoning depth for a session. Use at the start of complex architecture or refactor sessions (`/effort max`).
- `/clear` — Clears conversation context mid-session. Vojtech runs this ~45x/month — typically between unrelated tasks or when context gets noisy. Get in the habit.
- `/paperclip` — Interact with the Paperclip control-plane API (check task assignments, update status, post comments, manage routines). Use it for coordination, not for the actual domain work.
- `/design-guide` — Paperclip UI design system reference. Run it before creating or modifying any frontend component.
- `/simplify` — Post-implementation pass that reviews changed code for reuse and quality issues. Good habit after bigger feature sessions.
- `/security-review` — Runs a security audit over pending branch changes. Use before any merge that touches auth, API routes, or file-system access.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
