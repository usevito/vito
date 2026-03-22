#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "test-server", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// Define available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "echo",
        description: "Returns the input text",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text to echo" },
          },
          required: ["text"],
        },
      },
      {
        name: "read_file",
        description: "Reads a file (mock)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
          },
          required: ["path"],
        },
      },
      {
        name: "write_file",
        description: "Writes content to a file (mock)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to write" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
      },
      {
        name: "delete_file",
        description: "Deletes a file (mock)",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to delete" },
          },
          required: ["path"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const timestamp = new Date().toISOString();

  console.error(`[TEST-SERVER ${timestamp}] Tool called: ${name}`, JSON.stringify(args));

  switch (name) {
    case "echo": {
      const text = (args as { text: string }).text;
      return {
        content: [{ type: "text", text: JSON.stringify({ result: text }) }],
      };
    }

    case "read_file": {
      const path = (args as { path: string }).path;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              path,
              content: `Contents of ${path}`,
              size: 1024,
              modified: timestamp,
            }),
          },
        ],
      };
    }

    case "write_file": {
      const { path, content } = args as { path: string; content: string };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              path,
              bytesWritten: content.length,
              timestamp,
            }),
          },
        ],
      };
    }

    case "delete_file": {
      const path = (args as { path: string }).path;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              success: true,
              path,
              deleted: true,
              timestamp,
            }),
          },
        ],
      };
    }

    default:
      return {
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
        isError: true,
      };
  }
});

// Start the server
const transport = new StdioServerTransport();
server.connect(transport);
console.error("[TEST-SERVER] Started and waiting for connections...");
