# Windows Setup

dreb's built-in tools (`bash`, `grep`, `find`) execute commands through a bash shell. Windows doesn't ship with bash, so dreb searches for one at startup.

## Shell resolution order

1. Custom path from `~/.dreb/agent/settings.json` (see below)
2. Git Bash (`C:\Program Files\Git\bin\bash.exe`)
3. `bash.exe` on PATH (Cygwin, MSYS2, WSL)

For most users, [Git for Windows](https://git-scm.com/download/win) is the simplest option — it includes Git Bash and adds it to common paths.

## Custom shell path

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

## PowerShell

PowerShell is not supported. dreb's tool execution assumes bash semantics (pipes, redirects, `&&`/`||`, glob expansion). PowerShell uses different syntax for all of these, so commands the model generates would fail silently or behave unexpectedly.

## WSL vs Git Bash

Both work. Tradeoffs:

- **Git Bash** — lightweight, no VM, accesses Windows filesystem directly. Some Unix tools are missing or behave slightly differently (e.g., `find` flags).
- **WSL** — full Linux environment, all tools behave as expected. Filesystem access across the Windows/Linux boundary is slower. If your project lives on the Windows filesystem, Git Bash may be faster for file operations.

If you use WSL, consider running dreb entirely inside WSL rather than from Windows pointing at WSL's bash.

## Common issues

### Line endings (CRLF vs LF)

Git on Windows defaults to `core.autocrlf=true`, which converts LF to CRLF on checkout. This can cause issues with bash scripts and diffs. Configure git for your project:

```bash
git config core.autocrlf input
```

Or add a `.gitattributes` file:

```
* text=auto eol=lf
```

### Paths with spaces

dreb handles spaces in paths, but some tools the model invokes may not. If you see unexpected errors, check whether your project path contains spaces.

### Shell detection failures

If dreb can't find bash:

1. Verify bash exists: open a terminal and run `bash --version`
2. Check your PATH: `echo %PATH%` (cmd) or `$env:PATH` (PowerShell)
3. Set the path explicitly in `settings.json` (see above)
4. Check the debug log: run `/debug` in dreb, then look at `~/.dreb/agent/dreb-debug.log`
