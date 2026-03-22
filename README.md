# Vito

![version](https://img.shields.io/badge/version-0.1.0-blue)
![tests](https://img.shields.io/badge/tests-16%20passing-brightgreen)
![license](https://img.shields.io/badge/license-ISC-lightgrey)

Security proxy for MCP servers. Stops dangerous tool calls before they execute.

## What it does

- Blocks dangerous tool calls (`delete_file`, `rm -rf`, `drop table`)
- Enforces budget limits (agent stops when limit hit)
- Provides an emergency kill switch (one click, everything stops)
- Logs every decision (full audit trail)

## Why it matters

Agents with tool access can delete files, run shell commands, and burn through API credits. Most setups have zero guardrails. One bad loop can cost $500. One wrong command can wipe a directory.

Vito sits between your MCP client and your tools. Every call passes through. You set the rules.

## Demo

_TODO: Add terminal GIF showing blocked tool calls, budget exhaustion, and kill switch_

## Proof it works

| Command | Result |
|---------|--------|
| `npm run demo` | 5 scenarios pass — blocking, budgets, kill switch |
| `npm test` | 16 automated tests pass |
| `npm start` | Dashboard live at localhost:3000 |

No configuration required. Ships with test server and working defaults.

## Quickstart

```bash
git clone https://github.com/usevito/vito.git
cd vito
npm install
npm run build
npm run demo
```

## Features

- **Block tools** — `delete_file`, `rm`, `drop_table` → rejected
- **Budget limits** — hits limit → agent stops
- **Human approval** — sensitive ops pause for y/n
- **Injection detection** — scans args for manipulation
- **Rate limiting** — breaks runaway loops
- **Audit log** — every action recorded

## Architecture

```
┌─────────────┐     ┌───────────────────────────────────────┐     ┌──────────────┐
│  MCP Client │────▶│              Vito Proxy               │────▶│  MCP Server  │
│  (Claude)   │◀────│  ┌─────────────────────────────────┐  │◀────│  (Your Tools)│
└─────────────┘     │  │ Kill Switch                     │  │     └──────────────┘
                    │  │ Budget Check                    │  │
                    │  │ Prompt Injection Scanner        │  │
                    │  │ Circuit Breaker                 │  │
                    │  │ Blocked Tools                   │  │
                    │  │ Semantic Analysis               │  │
                    │  │ Human Approval Gate             │  │
                    │  └─────────────────────────────────┘  │
                    │                                       │
                    │  Dashboard: http://localhost:3000     │
                    └───────────────────────────────────────┘
```

## Project Structure

```
vito/
├── src/
│   ├── index.ts           # Main proxy server
│   ├── test-server.ts     # Mock MCP server for testing
│   ├── e2e-test.ts        # Automated test suite
│   ├── demo.ts            # Interactive demo
│   └── dashboard/
│       └── index.html     # Web dashboard
├── config.json            # Downstream server configuration
├── rules.json             # Security policy rules
├── logs/                  # Audit logs and budget state (auto-created)
├── package.json
├── tsconfig.json
└── Dockerfile
```

## Requirements

- Node.js 20+
- npm

## Configuration

### config.json

Defines which MCP servers Veto proxies to:

```json
{
  "downstreamServers": [
    {
      "name": "my-server",
      "command": "node",
      "args": ["path/to/my-server.js"]
    }
  ]
}
```

Tools are namespaced as `{server-name}__{tool-name}` (e.g., `my-server__read_file`).

### rules.json

Defines security policies:

```json
{
  "blocked_tools": ["delete_file", "rmdir", "uninstall"],
  "max_cost_per_task_usd": 0.50,
  "require_approval_for": ["write_file", "git_push"],
  "semantic_check_required": ["write_file", "git_push", "shell_execute"]
}
```

| Field | Description |
|-------|-------------|
| `blocked_tools` | Tool names that are always rejected |
| `max_cost_per_task_usd` | Budget limit (currently estimates $0.01/call) |
| `require_approval_for` | Tools that require manual y/n confirmation |
| `semantic_check_required` | Tools that undergo heuristic risk analysis |

### Environment Variables

| Variable | Description |
|----------|-------------|
| `VITO_ADMIN_KEY` | API key for dashboard authentication (optional) |

## Running

```bash
npm start
```

This starts the MCP proxy on stdio and the dashboard on `http://localhost:3000`.

To use as an MCP server, add to your MCP client configuration:

```json
{
  "mcpServers": {
    "veto": {
      "command": "node",
      "args": ["/path/to/veto-mcp/dist/index.js"]
    }
  }
}
```

## Demo

```bash
npm run demo
```

Runs 5 automated scenarios in ~10 seconds:

```
SCENARIO 1: SAFE TOOL CALL
  Tool: echo → ✅ PASS

SCENARIO 2: FILE READ OPERATION
  Tool: read_file → ✅ PASS

SCENARIO 3: DANGEROUS TOOL BLOCKED
  Tool: delete_file → VETOED → ✅ PASS

SCENARIO 4: BUDGET EXHAUSTION
  50 calls made → budget hit → agent stopped → ✅ PASS

SCENARIO 5: EMERGENCY KILL SWITCH
  Kill switch activated → all calls blocked → ✅ PASS
```

No mocks. These are real tool calls through the real proxy.

## Testing

Run the automated test suite:

```bash
npm test
```

This runs 16 end-to-end tests covering tool listing, allowed calls, blocked calls, audit logging, budget tracking, budget enforcement, dashboard API, and kill switch.

## Dashboard

Open `http://localhost:3000` to access the dashboard:

- View security status (Active / LOCKED)
- Monitor budget usage
- See live audit feed
- Activate emergency kill switch

If `VITO_ADMIN_KEY` is set, you'll be prompted for the key on first access.

## Security Checks (in order)

1. **Emergency Kill Switch** - Manual panic button blocks everything
2. **Budget Enforcement** - Blocks when spending limit reached
3. **Prompt Injection Scanner** - Detects manipulation patterns in arguments
4. **Circuit Breaker** - Blocks if >5 calls to same tool in 10 seconds
5. **Blocked Tools** - Rejects tools in blocklist
6. **Semantic Analysis** - Flags high-risk patterns (e.g., writing to `.env`)
7. **Human Approval** - Requires manual confirmation for sensitive tools

## Example Flow

```
Agent calls: test-server__delete_file { path: "/etc/passwd" }

Vito checks:
  ✓ Kill switch not active
  ✓ Budget OK ($0.02 of $0.50 spent)
  ✓ No prompt injection detected
  ✓ Circuit breaker OK
  ✗ Tool "delete_file" is in blocked_tools

Response to agent:
  "VETOED: This action is restricted by your security policy."

Audit log entry created:
  { tool: "delete_file", action: "VETOED", reason: "restricted" }
```

## Limitations

- **Cost estimation is mocked** - Currently uses flat $0.01/call, not actual API costs
- **Semantic analysis is heuristic** - Pattern matching, not AI-based analysis
- **Single budget scope** - One global budget, not per-agent or per-task
- **No persistent kill switch** - Kill switch resets on server restart
- **Stdio transport only** - No HTTP/SSE MCP transport support yet

## Roadmap

- [ ] Real cost tracking via API usage data
- [ ] Per-agent budget scopes
- [ ] Persistent kill switch state
- [ ] HTTP/SSE transport support
- [ ] Plugin system for custom security checks
- [ ] AI-powered semantic analysis

## License

ISC
