# Agentic patterns & MCP integration

### MCP server exposing Claws state to Claude sessions (#480)

Build a lightweight MCP server (or extend the existing HTTP server with MCP-compatible endpoints) that Claude sessions can query during task execution. Expose: current queue state (what else is being worked on), recent task history for the current repo (what was tried before, what failed), open PR list with CI status, and the operator's skip/priority lists. Currently, Claude sessions operate in isolation — they don't know if another session just attempted the same fix, or if there's a related PR already open. By making Claws state queryable via MCP, Claude can make smarter decisions: skip creating a duplicate PR, reference a related open issue, or avoid a fix approach that already failed. The QA phase job already uses MCP for Playwright; this extends the pattern to Claws's own operational data. The MCP config would be injected into the worktree alongside the task prompt.
