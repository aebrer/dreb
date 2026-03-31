---
name: telegram-send
description: Send files to the user via Telegram. Use when the user asks you to send, share, or deliver a file to them.
ui: telegram
---

# Telegram File Send

When you need to send a file to the user, include this marker in your response:

```
[[telegram:send:/absolute/path/to/file]]
```

The Telegram frontend detects this pattern, strips it from the displayed message, and sends the file as a Telegram document attachment.

## When to use

- User asks "send me that file"
- User asks "share the script you created"
- User asks to "deliver" or "export" something as a file
- After creating a file the user explicitly wants sent to them

## Examples

**User:** "Create a Python script and send it to me"
```
Here's the script I created.

[[telegram:send:/tmp/hello.py]]
```

**User:** "Send me my bashrc"
```
Here's your bashrc file:

[[telegram:send:/home/drew/.bashrc]]
```

## Rules

- Use **absolute paths** only
- The file must exist and be readable
- Multiple files: include multiple `[[telegram:send:...]]` markers
- The marker is stripped from the message before display — don't reference it in your text
- Non-existent paths are silently ignored
