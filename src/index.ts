#!/usr/bin/env node

import "dotenv/config";
import { Command } from "commander";
import { createDatabase, getDefaultDbPath } from "./db/sqlite.js";
import {
  integrationRegistry,
  runAllMigrations,
  syncIntegration,
  syncAllIntegrations,
} from "./core/integration.js";

// Import integrations to register them
import "./integrations/index.js";
import { stravaIntegration } from "./integrations/index.js";

const program = new Command();

program
  .name("mydata")
  .description("Personal data hub - sync data from various services into a local SQLite database")
  .version("1.0.0");

// Sync command
program
  .command("sync [integration]")
  .description("Sync data from services. If no integration specified, syncs all configured integrations.")
  .action(async (integrationName?: string) => {
    const db = createDatabase();

    try {
      // Run migrations first
      console.log("Running migrations...");
      runAllMigrations(db);

      if (integrationName) {
        // Sync specific integration
        const result = await syncIntegration(db, integrationName);
        if (result.success) {
          console.log(`\n✓ ${integrationName}: ${result.recordsSynced} records synced`);
        } else {
          console.error(`\n✗ ${integrationName}: Failed`);
          result.errors?.forEach((e) => console.error(`  - ${e}`));
          process.exit(1);
        }
      } else {
        // Sync all configured integrations
        const configured = integrationRegistry.getConfigured();
        if (configured.length === 0) {
          console.log("\nNo integrations configured. Set environment variables:");
          console.log("  LUNCHMONEY_API_KEY - for Lunch Money");
          console.log("  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_ACCESS_TOKEN - for Strava");
          console.log("  HEVY_CSV_PATH - for Hevy (path to workouts.csv file)");
          process.exit(1);
        }

        const results = await syncAllIntegrations(db);
        console.log("\nSync Results:");
        console.log("─".repeat(50));

        let hasErrors = false;
        for (const [name, result] of results) {
          if (result.success) {
            console.log(`✓ ${name}: ${result.recordsSynced} records synced`);
          } else {
            hasErrors = true;
            console.log(`✗ ${name}: Failed`);
            result.errors?.forEach((e) => console.log(`  - ${e}`));
          }
        }

        if (hasErrors) {
          process.exit(1);
        }
      }
    } finally {
      db.close();
    }
  });

// Auth command
program
  .command("auth <integration>")
  .description("Authenticate with a service (for OAuth-based integrations)")
  .action(async (integrationName: string) => {
    if (integrationName === "strava") {
      try {
        await stravaIntegration.authenticate();
      } catch (error) {
        console.error("Authentication failed:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    } else {
      console.error(`Integration "${integrationName}" does not support OAuth authentication.`);
      console.error("For API key-based integrations, set the environment variable directly.");
      process.exit(1);
    }
  });

// Query command
program
  .command("query <sql>")
  .description("Execute a SQL query against the database")
  .option("-f, --format <format>", "Output format (table, json, csv)", "table")
  .action((sql: string, options: { format: string }) => {
    const db = createDatabase();

    try {
      // Run migrations first to ensure tables exist
      runAllMigrations(db);

      const results = db.query(sql);

      if (results.length === 0) {
        console.log("No results");
        return;
      }

      switch (options.format) {
        case "json":
          console.log(JSON.stringify(results, null, 2));
          break;
        case "csv":
          const headers = Object.keys(results[0]);
          console.log(headers.join(","));
          for (const row of results) {
            console.log(
              headers
                .map((h) => {
                  const val = (row as Record<string, unknown>)[h];
                  if (val === null || val === undefined) return "";
                  const str = String(val);
                  return str.includes(",") ? `"${str}"` : str;
                })
                .join(",")
            );
          }
          break;
        default:
          // Table format
          console.table(results);
      }
    } catch (error) {
      console.error("Query error:", error instanceof Error ? error.message : error);
      process.exit(1);
    } finally {
      db.close();
    }
  });

// Status command
program
  .command("status")
  .description("Show configured integrations and sync status")
  .action(() => {
    const db = createDatabase();

    try {
      // Run migrations first
      runAllMigrations(db);

      console.log("\nIntegrations:");
      console.log("─".repeat(60));

      for (const integration of integrationRegistry.getAll()) {
        const configured = integration.isConfigured();
        const status = configured ? "✓ Configured" : "✗ Not configured";
        console.log(`${integration.displayName.padEnd(20)} ${status}`);
      }

      const syncStatuses = db.getSyncStatus();
      if (syncStatuses.length > 0) {
        console.log("\nLast Sync:");
        console.log("─".repeat(60));

        for (const status of syncStatuses) {
          const integration = integrationRegistry.get(status.integration);
          const name = integration?.displayName || status.integration;
          const success = status.last_sync_success ? "✓" : "✗";
          const time = status.last_sync_at || "Never";
          console.log(
            `${name.padEnd(20)} ${success} ${time.padEnd(25)} ${status.records_synced} records`
          );
          if (status.error_message) {
            console.log(`${"".padEnd(22)}Error: ${status.error_message}`);
          }
        }
      }

      console.log(`\nDatabase: ${getDefaultDbPath()}`);
    } finally {
      db.close();
    }
  });

// Tables command
program
  .command("tables")
  .description("List all tables in the database")
  .action(() => {
    const db = createDatabase();

    try {
      runAllMigrations(db);

      const tables = db.listTables();
      console.log("\nTables:");
      console.log("─".repeat(40));
      for (const table of tables) {
        const info = db.describeTable(table);
        if (info) {
          console.log(`\n${table} (${info.columns.length} columns)`);
          for (const col of info.columns) {
            const pk = col.pk ? " [PK]" : "";
            const nullable = col.notnull ? "" : " (nullable)";
            console.log(`  ${col.name}: ${col.type}${pk}${nullable}`);
          }
        }
      }
    } finally {
      db.close();
    }
  });

program.parse();

