"""
Parse Claude Code session files into a normalized structure for analysis.

Reads all .jsonl session files from ~/.claude/projects/, extracts structured
data about tool usage, session patterns, and features, then dumps to JSON
for downstream analysis and plotting.
"""

import json
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


CLAUDE_DIR = Path.home() / ".claude" / "projects"


def parse_session_file(filepath: Path) -> dict | None:
    """Parse a single .jsonl session file into a structured summary."""
    messages = []
    try:
        with open(filepath) as f:
            for line in f:
                line = line.strip()
                if line:
                    messages.append(json.loads(line))
    except (json.JSONDecodeError, OSError) as e:
        print(f"  Skipping {filepath}: {e}", file=sys.stderr)
        return None

    if not messages:
        return None

    # Basic session metadata
    first_msg = messages[0]
    session_id = first_msg.get("sessionId", filepath.stem)

    # Detect frontend: Telegram sessions start with queue-operation
    is_telegram = first_msg.get("type") == "queue-operation"

    # Extract project from path
    project_dir = filepath.parent.name
    if filepath.parent.parent.name != "projects":
        # Subagent or UUID-dir session
        project_dir = filepath.parent.parent.name

    # Collect per-message data
    tool_calls = []
    tool_sequence = []  # ordered list of tool names for chain analysis
    user_messages = []
    assistant_messages = []
    models = set()
    timestamps = []
    thinking_count = 0
    thinking_chars = 0
    text_block_count = 0
    text_chars = 0
    subagent_spawns = []
    skill_invocations = []
    version = None

    for msg in messages:
        msg_type = msg.get("type")
        ts = msg.get("timestamp")
        if ts:
            timestamps.append(ts)

        if not version and msg.get("version"):
            version = msg["version"]

        if msg_type == "user":
            content = msg.get("message", {}).get("content", "")
            if isinstance(content, str):
                user_messages.append(len(content))
            elif isinstance(content, list):
                # Could be tool_result blocks or text
                text_len = 0
                for block in content:
                    if isinstance(block, dict):
                        if block.get("type") == "text":
                            text_len += len(block.get("text", ""))
                    elif isinstance(block, str):
                        text_len += len(block)
                if text_len > 0:
                    user_messages.append(text_len)

        elif msg_type == "assistant":
            m = msg.get("message", {})
            model = m.get("model")
            if model and model != "<synthetic>":
                models.add(model)

            content = m.get("content", [])
            if not isinstance(content, list):
                continue

            for block in content:
                if not isinstance(block, dict):
                    continue

                block_type = block.get("type")

                if block_type == "tool_use":
                    name = block.get("name", "unknown")
                    tool_input = block.get("input", {})
                    tool_entry = {"name": name}

                    # Extract interesting tool-specific metadata
                    if name == "Agent":
                        subagent_type = tool_input.get("subagent_type", "general-purpose")
                        description = tool_input.get("description", "")
                        subagent_spawns.append({
                            "type": subagent_type,
                            "description": description,
                        })
                        tool_entry["subagent_type"] = subagent_type

                    elif name == "Skill":
                        skill_name = tool_input.get("skill", "unknown")
                        skill_invocations.append(skill_name)
                        tool_entry["skill"] = skill_name

                    elif name == "Bash":
                        # Track if it's a background command
                        tool_entry["background"] = tool_input.get("run_in_background", False)

                    tool_calls.append(tool_entry)
                    tool_sequence.append(name)

                elif block_type == "thinking":
                    thinking_count += 1
                    thinking_chars += len(block.get("thinking", ""))

                elif block_type == "text":
                    text_block_count += 1
                    text_chars += len(block.get("text", ""))
                    assistant_messages.append(len(block.get("text", "")))

    # Parse timestamps for duration
    parsed_times = []
    for ts in timestamps:
        try:
            parsed_times.append(datetime.fromisoformat(ts.replace("Z", "+00:00")))
        except (ValueError, AttributeError):
            pass

    duration_seconds = None
    start_time = None
    if len(parsed_times) >= 2:
        parsed_times.sort()
        start_time = parsed_times[0].isoformat()
        duration_seconds = (parsed_times[-1] - parsed_times[0]).total_seconds()

    # Tool frequency map
    tool_freq = defaultdict(int)
    for tc in tool_calls:
        tool_freq[tc["name"]] += 1

    return {
        "session_id": session_id,
        "project": project_dir,
        "is_telegram": is_telegram,
        "is_subagent": "subagents" in str(filepath),
        "version": version,
        "models": sorted(models),
        "start_time": start_time,
        "duration_seconds": duration_seconds,
        "user_message_count": len(user_messages),
        "user_message_lengths": user_messages,
        "assistant_text_blocks": text_block_count,
        "assistant_text_chars": text_chars,
        "assistant_message_lengths": assistant_messages,
        "total_messages": len([m for m in messages if m.get("type") in ("user", "assistant")]),
        "tool_calls": tool_calls,
        "tool_frequency": dict(tool_freq),
        "tool_sequence": tool_sequence,
        "thinking_count": thinking_count,
        "thinking_chars": thinking_chars,
        "subagent_spawns": subagent_spawns,
        "skill_invocations": skill_invocations,
    }


def find_session_files(base_dir: Path) -> list[Path]:
    """Find all .jsonl session files, both main and subagent."""
    files = []
    for root, dirs, filenames in os.walk(base_dir):
        for fname in filenames:
            if fname.endswith(".jsonl"):
                files.append(Path(root) / fname)
    return sorted(files)


def main():
    print(f"Scanning {CLAUDE_DIR} ...", file=sys.stderr)
    files = find_session_files(CLAUDE_DIR)
    print(f"Found {len(files)} session files", file=sys.stderr)

    sessions = []
    for i, f in enumerate(files):
        if (i + 1) % 50 == 0:
            print(f"  Parsed {i + 1}/{len(files)}...", file=sys.stderr)
        result = parse_session_file(f)
        if result:
            sessions.append(result)

    print(f"Successfully parsed {len(sessions)} sessions", file=sys.stderr)

    # Separate main vs subagent
    main_sessions = [s for s in sessions if not s["is_subagent"]]
    sub_sessions = [s for s in sessions if s["is_subagent"]]
    print(f"  Main: {len(main_sessions)}, Subagent: {len(sub_sessions)}", file=sys.stderr)

    output = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "total_files": len(files),
        "parsed_sessions": len(sessions),
        "main_sessions": main_sessions,
        "subagent_sessions": sub_sessions,
    }

    # Write to file
    out_path = Path(__file__).parent / "parsed_sessions.json"
    with open(out_path, "w") as f:
        json.dump(output, f, indent=2)
    print(f"Wrote {out_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
