import { z } from "zod";
import { SqliteDatabase } from "../db/sqlite.js";
import { integrationRegistry, runAllMigrations } from "../core/integration.js";

// Import integrations to register them
import "../integrations/index.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (db: SqliteDatabase, input: unknown) => Promise<unknown>;
}

// Query database tool
const queryDatabaseSchema = z.object({
  sql: z.string().describe("The SQL query to execute"),
  limit: z
    .number()
    .optional()
    .default(100)
    .describe("Maximum number of rows to return (default: 100)"),
});

export const queryDatabaseTool: ToolDefinition = {
  name: "query_database",
  description: `Execute a SQL query against the personal data database. 
This database contains data synced from various services:
- Lunch Money: transactions, categories, assets, recurring items (tables: lm_transactions, lm_categories, lm_assets, lm_plaid_accounts, lm_recurring)
- Strava: activities and athlete profile (tables: strava_activities, strava_athlete)

Use standard SQLite syntax. Results are limited to prevent overwhelming responses.`,
  inputSchema: queryDatabaseSchema,
  handler: async (db, input) => {
    const { sql, limit } = queryDatabaseSchema.parse(input);

    // Add LIMIT if not present and query is a SELECT
    let finalSql = sql.trim();
    const isSelect = finalSql.toLowerCase().startsWith("select");
    if (isSelect && !finalSql.toLowerCase().includes("limit")) {
      finalSql = `${finalSql} LIMIT ${limit}`;
    }

    try {
      const results = db.query(finalSql);
      return {
        success: true,
        rowCount: results.length,
        results,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
};

// List tables tool
const listTablesSchema = z.object({});

export const listTablesTool: ToolDefinition = {
  name: "list_tables",
  description: `List all tables in the personal data database with their column information.
Returns table names and basic schema information to help you understand what data is available.`,
  inputSchema: listTablesSchema,
  handler: async (db) => {
    const tables = db.listTables();
    const tableInfo = tables.map((tableName) => {
      const info = db.describeTable(tableName);
      return {
        name: tableName,
        columns: info?.columns.map((col) => ({
          name: col.name,
          type: col.type,
          primaryKey: col.pk,
          nullable: !col.notnull,
        })),
      };
    });

    return {
      success: true,
      tables: tableInfo,
    };
  },
};

// Describe table tool
const describeTableSchema = z.object({
  table: z.string().describe("The name of the table to describe"),
  includeSampleData: z
    .boolean()
    .optional()
    .default(false)
    .describe("Whether to include sample rows from the table"),
});

export const describeTableTool: ToolDefinition = {
  name: "describe_table",
  description: `Get detailed information about a specific table, including its schema and optionally sample data.
Useful for understanding the structure and contents of a table before querying it.`,
  inputSchema: describeTableSchema,
  handler: async (db, input) => {
    const { table, includeSampleData } = describeTableSchema.parse(input);

    const info = db.describeTable(table);
    if (!info) {
      return {
        success: false,
        error: `Table "${table}" not found`,
      };
    }

    const result: Record<string, unknown> = {
      success: true,
      table: info.name,
      columns: info.columns.map((col) => ({
        name: col.name,
        type: col.type,
        primaryKey: col.pk,
        nullable: !col.notnull,
        defaultValue: col.dflt_value,
      })),
    };

    // Get row count
    const countResult = db.queryOne<{ count: number }>(`SELECT COUNT(*) as count FROM ${table}`);
    result.rowCount = countResult?.count ?? 0;

    // Include sample data if requested
    if (includeSampleData) {
      result.sampleRows = db.query(`SELECT * FROM ${table} LIMIT 5`);
    }

    return result;
  },
};

// Get sync status tool
const getSyncStatusSchema = z.object({});

export const getSyncStatusTool: ToolDefinition = {
  name: "get_sync_status",
  description: `Get the sync status for all integrations, including when they were last synced and how many records were imported.
Useful for understanding how fresh the data is.`,
  inputSchema: getSyncStatusSchema,
  handler: async (db) => {
    const statuses = db.getSyncStatus();
    const integrations = integrationRegistry.getAll().map((i) => ({
      name: i.name,
      displayName: i.displayName,
      configured: i.isConfigured(),
    }));

    return {
      success: true,
      integrations: integrations.map((integration) => {
        const status = statuses.find((s) => s.integration === integration.name);
        return {
          ...integration,
          lastSync: status?.last_sync_at ?? null,
          lastSyncSuccess: status?.last_sync_success ?? null,
          recordsSynced: status?.records_synced ?? 0,
          error: status?.error_message ?? null,
        };
      }),
    };
  },
};

// Export all tools
export const allTools: ToolDefinition[] = [
  queryDatabaseTool,
  listTablesTool,
  describeTableTool,
  getSyncStatusTool,
];

// Helper to get tool by name
export function getTool(name: string): ToolDefinition | undefined {
  return allTools.find((t) => t.name === name);
}

// Run migrations helper
export function ensureMigrations(db: SqliteDatabase): void {
  runAllMigrations(db);
}

