import { SqliteDatabase, Migration } from "../db/sqlite.js";

export interface SyncResult {
  success: boolean;
  recordsSynced: number;
  errors?: string[];
}

export interface Integration {
  /** Unique identifier for this integration */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Check if the integration is configured (has required credentials) */
  isConfigured(): boolean;

  /** Get the migrations for this integration's tables */
  getMigrations(): Migration[];

  /** Sync data from the service into the database */
  sync(db: SqliteDatabase): Promise<SyncResult>;
}

/**
 * Registry of all available integrations
 */
class IntegrationRegistry {
  private integrations: Map<string, Integration> = new Map();

  register(integration: Integration): void {
    this.integrations.set(integration.name, integration);
  }

  get(name: string): Integration | undefined {
    return this.integrations.get(name);
  }

  getAll(): Integration[] {
    return Array.from(this.integrations.values());
  }

  getConfigured(): Integration[] {
    return this.getAll().filter((i) => i.isConfigured());
  }

  list(): string[] {
    return Array.from(this.integrations.keys());
  }
}

export const integrationRegistry = new IntegrationRegistry();

/**
 * Run migrations for all registered integrations
 */
export function runAllMigrations(db: SqliteDatabase): void {
  for (const integration of integrationRegistry.getAll()) {
    const migrations = integration.getMigrations();
    if (migrations.length > 0) {
      db.runMigrations(integration.name, migrations);
    }
  }
}

/**
 * Sync a specific integration
 */
export async function syncIntegration(
  db: SqliteDatabase,
  integrationName: string,
): Promise<SyncResult> {
  const integration = integrationRegistry.get(integrationName);

  if (!integration) {
    return {
      success: false,
      recordsSynced: 0,
      errors: [`Unknown integration: ${integrationName}`],
    };
  }

  if (!integration.isConfigured()) {
    return {
      success: false,
      recordsSynced: 0,
      errors: [`Integration ${integrationName} is not configured. Check environment variables.`],
    };
  }

  try {
    console.log(`Syncing ${integration.displayName}...`);
    const result = await integration.sync(db);
    db.updateSyncStatus(
      integrationName,
      result.success,
      result.recordsSynced,
      result.errors?.join("; "),
    );
    return result;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    db.updateSyncStatus(integrationName, false, 0, errorMessage);
    return {
      success: false,
      recordsSynced: 0,
      errors: [errorMessage],
    };
  }
}

/**
 * Sync all configured integrations
 */
export async function syncAllIntegrations(db: SqliteDatabase): Promise<Map<string, SyncResult>> {
  const results = new Map<string, SyncResult>();

  for (const integration of integrationRegistry.getConfigured()) {
    const result = await syncIntegration(db, integration.name);
    results.set(integration.name, result);
  }

  return results;
}
