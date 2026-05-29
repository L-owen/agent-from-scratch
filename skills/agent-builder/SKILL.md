---
name: agent-builder
description: Guide for building autonomous AI agents with tool use, planning, and error recovery.
---

# Agent Builder Skill

## Overview

This skill provides guidance for building autonomous AI agents that can use tools, plan multi-step tasks, and recover from errors.

## Key Principles

1. **Tool Use**: Define tools with clear input schemas. The agent dispatches tool calls through a handler registry.
2. **Planning**: Before starting multi-step work, the agent should create a plan (todo list) and track progress.
3. **Error Recovery**: When a tool call fails, the agent should analyze the error and try an alternative approach.
4. **Context Management**: Keep the conversation history focused. Summarize or compress old context when it grows too large.

## Agent Loop Pattern

```
while true:
  response = LLM(messages, tools)
  if no tool calls → done, output text
  for each tool call:
    result = execute(tool, args)
    append tool_result to messages
```

## Best Practices

- Use a system prompt that clearly states the agent's role and capabilities
- Implement permission checks before executing dangerous operations
- Log all tool calls for debugging and auditing
- Set a maximum iteration limit to prevent infinite loops
