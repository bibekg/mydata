import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

// Get the directory where this module is located
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// Project root is two levels up from dist/db/sqlite.js
const PROJECT_ROOT = resolve(__dirname, "..", "..");

export interface Migration {
  version: number;
  name: string;
  up: string;
}

export interface TableInfo {
  name: string;
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  pk: boolean;
  dflt_value: string | null;
}

export class SqliteDatabase {
  private db: Database.Database;
  private dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;

    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.initMigrationTable();
  }

  private initMigrationTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _sync_status (
        integration TEXT PRIMARY KEY,
        last_sync_at TEXT,
        last_sync_success INTEGER,
        records_synced INTEGER,
        error_message TEXT
      )
    `);
  }

  /**
   * Run migrations for a specific integration
   */
  runMigrations(integration: string, migrations: Migration[]): void {
    const appliedVersions = new Set(
      this.db
        .prepare("SELECT version FROM _migrations WHERE name LIKE ?")
        .all(`${integration}:%`)
        .map((row: unknown) => (row as { version: number }).version),
    );

    for (const migration of migrations) {
      if (!appliedVersions.has(migration.version)) {
        this.db.exec(migration.up);
        this.db
          .prepare("INSERT INTO _migrations (version, name) VALUES (?, ?)")
          .run(migration.version, `${integration}:${migration.name}`);
        console.log(`  Applied migration: ${integration}:${migration.name}`);
      }
    }
  }

  /**
   * Execute a query and return results
   */
  query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params) as T[];
  }

  /**
   * Execute a query and return the first result
   */
  queryOne<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  }

  /**
   * Execute a statement (INSERT, UPDATE, DELETE)
   */
  execute(sql: string, params: unknown[] = []): Database.RunResult {
    const stmt = this.db.prepare(sql);
    return stmt.run(...params);
  }

  /**
   * Execute multiple statements in a transaction
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Quote a column name to handle reserved keywords
   */
  private quoteColumn(col: string): string {
    return `"${col}"`;
  }

  /**
   * Insert or replace a row
   */
  upsert(table: string, data: Record<string, unknown>): Database.RunResult {
    const columns = Object.keys(data);
    const quotedColumns = columns.map((c) => this.quoteColumn(c)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const values = Object.values(data);

    const sql = `INSERT OR REPLACE INTO ${table} (${quotedColumns}) VALUES (${placeholders})`;
    return this.execute(sql, values);
  }

  /**
   * Bulk insert rows
   */
  bulkInsert(table: string, rows: Record<string, unknown>[]): void {
    if (rows.length === 0) return;

    const columns = Object.keys(rows[0]);
    const quotedColumns = columns.map((c) => this.quoteColumn(c)).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const sql = `INSERT OR REPLACE INTO ${table} (${quotedColumns}) VALUES (${placeholders})`;

    const stmt = this.db.prepare(sql);
    const insertMany = this.db.transaction((items: Record<string, unknown>[]) => {
      for (const item of items) {
        stmt.run(...columns.map((col) => item[col]));
      }
    });

    insertMany(rows);
  }

  /**
   * Update sync status for an integration
   */
  updateSyncStatus(
    integration: string,
    success: boolean,
    recordsSynced: number,
    errorMessage?: string,
  ): void {
    this.execute(
      `INSERT OR REPLACE INTO _sync_status 
       (integration, last_sync_at, last_sync_success, records_synced, error_message)
       VALUES (?, datetime('now'), ?, ?, ?)`,
      [integration, success ? 1 : 0, recordsSynced, errorMessage ?? null],
    );
  }

  /**
   * Get sync status for all integrations
   */
  getSyncStatus(): Array<{
    integration: string;
    last_sync_at: string | null;
    last_sync_success: boolean;
    records_synced: number;
    error_message: string | null;
  }> {
    return this.query<{
      integration: string;
      last_sync_at: string | null;
      last_sync_success: number;
      records_synced: number;
      error_message: string | null;
    }>("SELECT * FROM _sync_status").map((row) => ({
      ...row,
      last_sync_success: row.last_sync_success === 1,
    }));
  }

  /**
   * List all tables in the database
   */
  listTables(): string[] {
    return this.query<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).map((row) => row.name);
  }

  /**
   * Get table schema information
   */
  describeTable(tableName: string): TableInfo | null {
    const columns = this.query<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>(`PRAGMA table_info(${tableName})`);

    if (columns.length === 0) return null;

    return {
      name: tableName,
      columns: columns.map((col) => ({
        name: col.name,
        type: col.type,
        notnull: col.notnull === 1,
        pk: col.pk === 1,
        dflt_value: col.dflt_value,
      })),
    };
  }

  /**
   * Get the database path
   */
  getPath(): string {
    return this.dbPath;
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}

// Default database path - uses absolute path to ensure consistency
export function getDefaultDbPath(): string {
  if (process.env.MYDATA_DB_PATH) {
    return process.env.MYDATA_DB_PATH;
  }
  // Use absolute path relative to project root
  return resolve(PROJECT_ROOT, "data", "mydata.db");
}

// Create a database instance
export function createDatabase(dbPath?: string): SqliteDatabase {
  return new SqliteDatabase(dbPath || getDefaultDbPath());
}
