#!/usr/bin/env node

import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { readFileSync, existsSync } from "fs";

// Manually load .env to avoid any stdout output from dotenv
// MCP uses stdio for JSON-RPC, so any stdout pollution breaks the protocol
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, "..");
const envPath = resolve(projectRoot, ".env");

if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, "utf-8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex > 0) {
        const key = trimmed.slice(0, eqIndex).trim();
        const value = trimmed.slice(eqIndex + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createDatabase } from "./db/sqlite.js";
import { allTools, getTool, ensureMigrations } from "./mcp/tools.js";

// Create database connection
const db = createDatabase();
ensureMigrations(db);

// Create MCP server
const server = new Server(
  {
    name: "mydata",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: {
        type: "object" as const,
        properties: Object.fromEntries(
          Object.entries((tool.inputSchema as any)._def?.shape?.() ?? {}).map(
            ([key, schema]: [string, any]) => [
              key,
              {
                type: getJsonSchemaType(schema),
                description: schema._def?.description,
              },
            ]
          )
        ),
        required: Object.entries((tool.inputSchema as any)._def?.shape?.() ?? {})
          .filter(([, schema]: [string, any]) => !schema.isOptional?.())
          .map(([key]) => key),
      },
    })),
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const tool = getTool(name);
  if (!tool) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ error: `Unknown tool: ${name}` }),
        },
      ],
    };
  }

  try {
    const result = await tool.handler(db, args ?? {});
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        },
      ],
    };
  }
});

// List resources (provide info about the database)
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "mydata://schema",
        name: "Database Schema",
        description: "Complete schema of all tables in the personal data database",
        mimeType: "application/json",
      },
      {
        uri: "mydata://status",
        name: "Sync Status",
        description: "Current sync status for all integrations",
        mimeType: "application/json",
      },
    ],
  };
});

// Read resources
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === "mydata://schema") {
    const tables = db.listTables();
    const schema = tables.map((tableName) => {
      const info = db.describeTable(tableName);
      const countResult = db.queryOne<{ count: number }>(
        `SELECT COUNT(*) as count FROM ${tableName}`
      );
      return {
        name: tableName,
        rowCount: countResult?.count ?? 0,
        columns: info?.columns.map((col) => ({
          name: col.name,
          type: col.type,
          primaryKey: col.pk,
          nullable: !col.notnull,
        })),
      };
    });

    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(schema, null, 2),
        },
      ],
    };
  }

  if (uri === "mydata://status") {
    const tool = getTool("get_sync_status");
    if (tool) {
      const result = await tool.handler(db, {});
      return {
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }
  }

  throw new Error(`Unknown resource: ${uri}`);
});

// Helper function to convert Zod types to JSON Schema types
function getJsonSchemaType(schema: any): string {
  const typeName = schema._def?.typeName;
  switch (typeName) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodArray":
      return "array";
    case "ZodObject":
      return "object";
    case "ZodOptional":
      return getJsonSchemaType(schema._def?.innerType);
    case "ZodDefault":
      return getJsonSchemaType(schema._def?.innerType);
    default:
      return "string";
  }
}

// Start the server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server started successfully (no output to avoid stdio pollution)
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

// Handle cleanup
process.on("SIGINT", () => {
  db.close();
  process.exit(0);
});

process.on("SIGTERM", () => {
  db.close();
  process.exit(0);
});

