# JSON Event Stream Mode

```bash
dreb --mode json "Your prompt"
```

Outputs all session events as JSON lines to stdout. Useful for integrating dreb into other tools or custom UIs.

## Event Types

Events are defined in [`AgentSessionEvent`](https://github.com/aebrer/dreb/blob/master/packages/coding-agent/src/core/agent-session.ts):

```typescript
type AgentSessionEvent =
  | AgentEvent
  | { type: "auto_compaction_start"; reason: "threshold" | "overflow" }
  | { type: "auto_compaction_end"; result: CompactionResult | undefined; aborted: boolean; willRetry: boolean; errorMessage?: string }
  | { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
  | { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
  | { type: "background_agent_start"; agentId: string; agentType: string; taskSummary: string }
  | { type: "background_agent_end"; agentId: string; agentType: string; success: boolean }
  | { type: "tasks_update"; tasks: readonly SessionTask[] };

// SessionTask shape:
interface SessionTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}
```

Base events from [`AgentEvent`](https://github.com/aebrer/dreb/blob/master/packages/agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start"; model?: { provider: string; id: string } }
  | { type: "agent_end"; messages: AgentMessage[] }
  // Turn lifecycle
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  // Message lifecycle
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | { type: "message_end"; message: AgentMessage }
  // Tool execution
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean };
```

## Message Types

Base messages from [`packages/ai/src/types.ts`](https://github.com/aebrer/dreb/blob/master/packages/ai/src/types.ts):
- `UserMessage`
- `AssistantMessage`
- `ToolResultMessage`

Extended messages from [`packages/coding-agent/src/core/messages.ts`](https://github.com/aebrer/dreb/blob/master/packages/coding-agent/src/core/messages.ts):
- `BashExecutionMessage`
- `CustomMessage`
- `BranchSummaryMessage`
- `CompactionSummaryMessage`

## Output Format

Each line is a JSON object. The first line is the session header (`version` is the session schema version; increments indicate breaking format changes):

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
```

Followed by events as they occur:

```json
{"type":"agent_start","model":{"provider":"anthropic","id":"claude-sonnet-4-20250514"}}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

## Error handling

Errors surface as events, not as broken JSON or exit codes:

- **LLM failures** (rate limits, network errors) trigger `auto_retry_start` / `auto_retry_end` events. dreb retries automatically with backoff. If all retries fail, `auto_retry_end` has `success: false` and `finalError` set.
- **Tool execution errors** produce a `tool_execution_end` event with `isError: true` and the error message in `result`.
- **Context overflow** triggers `auto_compaction_start` / `auto_compaction_end`. If compaction fails, `errorMessage` is set.

The JSON stream always ends with an `agent_end` event, even on failure. If the process exits without `agent_end`, the connection was interrupted (e.g., SIGTERM).

## Event ordering

Events are emitted in a predictable sequence:

1. `agent_start` — once, at the beginning
2. For each turn: `turn_start` → `message_start` → `message_update`* → `message_end` → `tool_execution_start` → `tool_execution_update`* → `tool_execution_end` (per tool) → `turn_end`
3. `agent_end` — once, at the end

`message_update` events stream as chunks arrive — expect many per message. `tool_execution_update` events are optional (only emitted for tools that report progress).

Auto-compaction and auto-retry events can appear between turns.

## Example

```bash
# 2>/dev/null suppresses startup/TUI output on stderr
dreb --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
