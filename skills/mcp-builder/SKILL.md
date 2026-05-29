---
name: mcp-builder
description: Guide for creating MCP (Model Context Protocol) servers that expose tools to LLMs.
---

# MCP Builder Skill

## Overview

This skill provides guidance for building MCP (Model Context Protocol) servers that enable LLMs to interact with external services through well-designed tools.

## MCP Server Structure

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const server = new McpServer({ name: "my-server", version: "1.0.0" });

server.tool("tool_name", "Description", { param: z.string() }, async (args) => {
  // implementation
  return { content: [{ type: "text", text: "result" }] };
});
```

## Tool Design Principles

1. **Clear Descriptions**: Each tool should have a concise description explaining what it does and when to use it.
2. **Typed Parameters**: Use Zod schemas for input validation.
3. **Error Handling**: Return meaningful error messages, not exceptions.
4. **Idempotency**: Read operations should be safe to call multiple times.

## Common Patterns

- **Resource Tools**: Expose data sources (files, APIs, databases)
- **Action Tools**: Perform operations (create, update, delete)
- **Query Tools**: Search and filter data

## Best Practices

- Keep tool descriptions under 100 words
- Use descriptive parameter names
- Validate all inputs at the boundary
- Return structured, machine-readable output
