---
name: guarded
description: Write agent with a deny list and a conservative shell allowlist
tools: read, bash, edit, write, grep
disallowedTools: edit, write
allowedCommands:
  - git status
  - npm test
---
Guarded body.
