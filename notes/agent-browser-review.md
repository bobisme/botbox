# Agent-Browser Tool Review

A review of the `agent-browser` CLI tool for web automation, tested by exploring agent-flywheel.com.

## Overview

`agent-browser` is a CLI-based browser automation tool designed specifically for AI agents. It wraps Playwright and provides a command-line interface for navigation, interaction, and content extraction.

## What Worked Well

### Excellent CLI Design
- **Comprehensive help**: `--help` output is thorough and well-organized
- **Session management**: The `--session` flag maintains browser state between commands, essential for multi-step workflows
- **Clean output**: Success/failure clearly indicated with colored checkmarks
- **Ref-based interaction**: The `@ref` system (e.g., `@e1`, `@e12`) for clicking elements is intuitive once you get the snapshot

### Accessibility Snapshots
- The `snapshot` command provides structured accessibility tree output that's easy to parse
- Interactive element refs make targeting straightforward
- Flags like `-i` (interactive only), `-c` (compact), `-d` (depth limit) offer useful filtering
- Large outputs are automatically saved to temp files (useful for big pages)

### Core Navigation
- `open`, `click`, `scroll` all work reliably
- URL and title extraction (`get url`, `get title`) work well
- Screenshots save correctly to specified paths

### Selectors
- CSS selectors work as expected
- The ref system (`@e1`) is much easier than writing complex CSS selectors
- Error messages are helpful when selectors match multiple elements

## What Was Frustrating

### Snapshot Output Can Be Overwhelming
- For complex pages, the snapshot output is very verbose (29KB+ for a single page)
- Even with `-c` (compact) flag, still a lot of noise
- Would benefit from better filtering options (e.g., filter by element type, exclude boilerplate)

### No Direct Text Extraction
- Getting raw page text requires parsing the snapshot or using `eval` with custom JS
- Would love a `get text [selector]` for plain text content
- The snapshot format is good for structure but awkward when you just want to read content

### Tab Management Not Tested
- Didn't explore tabs, but single-tab workflow was sufficient
- Unclear how tab state interacts with session persistence

### Limited Feedback on Actions
- `click` just says "Done" - no feedback on what happened
- Would be helpful to show the new URL if navigation occurred, or the element that was clicked

## Missing Features / UX Suggestions

1. **Content extraction mode**: A mode that outputs page content as clean markdown would be ideal for research tasks

2. **Smarter snapshot defaults**: Default could exclude purely structural elements more aggressively

3. **Action chaining**: Ability to chain commands like `agent-browser open URL && click SELECTOR && snapshot` with persistent state

4. **Wait for navigation**: After clicking links, an automatic wait for page load would prevent race conditions

5. **Element info command**: Something like `info @e1` to show element details (tag, attributes, text) without full snapshot

6. **Search in snapshot**: A grep-like search over the snapshot output directly (rather than piping through grep)

## Performance

- Commands executed in under 1 second for simple operations
- Page loads were reasonably fast
- No noticeable lag between commands
- Browser reuse via sessions works well for performance

## Comparison to Alternatives

Compared to Puppeteer/Playwright scripts:
- **Pros**: No code needed, faster iteration, good for exploration
- **Cons**: Less precise control, harder to do complex conditional logic

Compared to browser devtools:
- **Pros**: Scriptable, automatable, AI-friendly output
- **Cons**: Can't visually inspect as easily (though screenshots help)

## Verdict: Recommended (with caveats)

**For AI agent web exploration: Yes, recommended.**

The tool is well-suited for:
- Research/exploration tasks
- Simple form filling
- Content scraping from known page structures
- Multi-step workflows with session persistence

Less suited for:
- Complex SPA interactions (may need custom waits)
- Tasks requiring visual inspection of layout
- High-volume scraping (rate limiting considerations)

**Overall rating: 7.5/10**

The tool does what it says on the tin. The accessibility snapshot approach is clever and works well for AI consumption. Main improvement opportunities are in content extraction and smarter defaults for snapshot output. Would use again for similar tasks.
