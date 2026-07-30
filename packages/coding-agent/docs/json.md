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
  | { type: "background_agent_start"; agentId: string; agentType: string; taskSummary: string; sessionDir?: string }
  | { type: "subagent_arbitration"; agentId: string; status: "success" | "failure"; proposed: DispatchRoute; final: DispatchRoute | null; changed: ("agent" | "model" | "thinking")[]; step?: number; errorCode?: string; errorMessage?: string }
  | { type: "background_agent_end"; agentId: string; agentType: string; success: boolean; model?: string; thinking?: ThinkingLevel; steps?: SubagentStepMetadata[]; sessionFile?: string }
  | { type: "background_agent_event"; agentId: string; event: Record<string, unknown> }
  | { type: "parent_paused_for_background_agents"; runningAgentCount: number; turnsUsed: number; turnLimit: number }
  | { type: "session_name_changed"; name: string }
  | { type: "tasks_update"; tasks: readonly SessionTask[] }
  | { type: "suggest_next"; command: string };

// SessionTask shape:
interface SessionTask {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed";
}

interface SubagentStepMetadata {
  step: number;
  agent: string;
  success: boolean;
  model?: string; // canonical provider/model
  thinking?: ThinkingLevel;
}

interface DispatchRoute {
  agent: string;
  model: string; // canonical provider/model
  thinking: ThinkingLevel;
}
```

Base events from [`AgentEvent`](https://github.com/aebrer/dreb/blob/master/packages/agent/src/types.ts):

```typescript
type AgentEvent =
  // Agent lifecycle
  | { type: "agent_start"; model?: { provider: string; id: string }; thinkingLevel?: ThinkingLevel }
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

Each line is a JSON object. The first line is the session header (`version` is the session schema version; increments indicate breaking format changes). Subagent child sessions also include `agentType`:

```json
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path"}
{"type":"session","version":3,"id":"uuid","timestamp":"...","cwd":"/path","agentType":"feature-dev"}
```

Followed by events as they occur:

```json
{"type":"agent_start","model":{"provider":"anthropic","id":"claude-sonnet-4-20250514"},"thinkingLevel":"high"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"assistant","content":[],...}}
{"type":"message_update","message":{...},"assistantMessageEvent":{"type":"text_delta","delta":"Hello",...}}
{"type":"message_end","message":{...}}
{"type":"turn_end","message":{...},"toolResults":[]}
{"type":"agent_end","messages":[...]}
```

With global Dispatch Arbiter enabled, each background start is followed before child events/spawn by one safe structured decision. Unchanged decisions use an empty `changed`; failed decisions use `final: null`, prevent spawn, and carry only host-generated errors. Chain decisions also include `step`.

```json
{"type":"subagent_arbitration","agentId":"a1b2c3","status":"success","proposed":{"agent":"Explore","model":"provider/frontier","thinking":"high"},"final":{"agent":"feature-dev","model":"provider/worker","thinking":"medium"},"changed":["agent","model","thinking"]}
```

The event never contains the arbiter prompt, response, reasoning, guide, task, or conversation excerpt. The matching parent session persists the same safe fields as a non-context custom JSONL entry.

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

Auto-compaction and auto-retry events can appear between turns. Background lifecycle events are asynchronous: `background_agent_start` is emitted immediately, then an enabled `subagent_arbitration` record appears before that child's first `background_agent_event`; a failed arbitration is followed by `background_agent_end` without any child event.

## Example

```bash
# 2>/dev/null suppresses startup/TUI output on stderr
dreb --mode json "List files" 2>/dev/null | jq -c 'select(.type == "message_end")'
```
