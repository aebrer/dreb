# Shell Aliases

dreb runs bash in non-interactive mode (`bash -c "<command>"`). Non-interactive bash doesn't load your shell config files (`.bashrc`, `.bash_profile`) and doesn't expand aliases by default.

## Enabling aliases

Add to `~/.dreb/agent/settings.json`:

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bashrc 2>/dev/null\n"
}
```

The `shellCommandPrefix` is prepended to every bash command dreb executes. This sources your config and enables alias expansion.

Adjust the path to match your shell config: `~/.bashrc`, `~/.bash_profile`, etc.

## Performance warning

`shellCommandPrefix` runs on **every** bash command — including simple things like `ls` or `cat`. If your `.bashrc` is slow (loads nvm, conda, pyenv, etc.), this adds latency to every tool call.

To avoid this, source only the aliases you need instead of the full config:

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.bashrc)\"\n"
}
```

This extracts only `alias` lines, skipping everything else.

## zsh and fish

The `shellCommandPrefix` runs inside bash, not your login shell. If your aliases are defined in `~/.zshrc` or `~/.config/fish/config.fish`, the `grep` approach works for simple aliases:

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\neval \"$(grep '^alias ' ~/.zshrc)\"\n"
}
```

Complex zsh/fish aliases that use shell-specific syntax won't translate to bash. For those, consider wrapper scripts in your `$PATH` instead.

## Alternative: wrapper scripts

If you have commands you frequently want dreb to use (e.g., `docker-compose`, `kubectl` shortcuts), you can create small scripts in a directory on your `$PATH` instead of relying on aliases:

```bash
#!/bin/bash
# ~/bin/dc — shortcut for docker-compose
exec docker-compose "$@"
```

This works without any `shellCommandPrefix` configuration.
