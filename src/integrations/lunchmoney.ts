import { Integration, SyncResult, integrationRegistry } from "../core/integration.js";
import { SqliteDatabase, Migration } from "../db/sqlite.js";

const API_BASE = "https://dev.lunchmoney.app/v1";

interface LunchMoneyCategory {
  id: number;
  name: string;
  description: string | null;
  is_income: boolean;
  exclude_from_budget: boolean;
  exclude_from_totals: boolean;
  is_group: boolean;
  group_id: number | null;
  order: number;
  archived: boolean;
  created_at: string;
}

interface LunchMoneyTransaction {
  id: number;
  date: string;
  payee: string;
  amount: string;
  currency: string;
  to_base: number;
  notes: string | null;
  category_id: number | null;
  category_name: string | null;
  category_group_id: number | null;
  category_group_name: string | null;
  asset_id: number | null;
  plaid_account_id: number | null;
  status: string;
  parent_id: number | null;
  is_group: boolean;
  group_id: number | null;
  tags: Array<{ id: number; name: string }> | null;
  external_id: string | null;
  original_name: string | null;
  recurring_id: number | null;
  recurring_payee: string | null;
}

interface LunchMoneyAsset {
  id: number;
  type_name: string;
  subtype_name: string | null;
  name: string;
  display_name: string | null;
  balance: string;
  balance_as_of: string;
  closed_on: string | null;
  currency: string;
  institution_name: string | null;
  exclude_transactions: boolean;
  created_at: string;
  to_base: number;
}

interface LunchMoneyPlaidAccount {
  id: number;
  date_linked: string;
  name: string;
  display_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  institution_name: string | null;
  status: string;
  last_import: string | null;
  balance: string;
  currency: string;
  balance_last_update: string;
  limit: number | null;
  to_base: number;
}

interface LunchMoneyRecurringItem {
  id: number;
  start_date: string;
  end_date: string | null;
  payee: string;
  currency: string;
  amount: string;
  to_base: number;
  cadence: string;
  description: string | null;
  billing_date: string;
  type: string;
  original_name: string | null;
  source: string;
  plaid_account_id: number | null;
  asset_id: number | null;
  category_id: number | null;
}

class LunchMoneyIntegration implements Integration {
  name = "lunchmoney";
  displayName = "Lunch Money";

  private get apiKey(): string | undefined {
    return process.env.LUNCHMONEY_API_KEY;
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  getMigrations(): Migration[] {
    return [
      {
        version: 1,
        name: "create_categories",
        up: `
          CREATE TABLE IF NOT EXISTS lm_categories (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            is_income INTEGER NOT NULL DEFAULT 0,
            exclude_from_budget INTEGER NOT NULL DEFAULT 0,
            exclude_from_totals INTEGER NOT NULL DEFAULT 0,
            is_group INTEGER NOT NULL DEFAULT 0,
            group_id INTEGER,
            "order" INTEGER,
            archived INTEGER NOT NULL DEFAULT 0,
            created_at TEXT
          )
        `,
      },
      {
        version: 2,
        name: "create_transactions",
        up: `
          CREATE TABLE IF NOT EXISTS lm_transactions (
            id INTEGER PRIMARY KEY,
            date TEXT NOT NULL,
            payee TEXT NOT NULL,
            amount TEXT NOT NULL,
            currency TEXT NOT NULL,
            to_base REAL,
            notes TEXT,
            category_id INTEGER,
            category_name TEXT,
            category_group_id INTEGER,
            category_group_name TEXT,
            asset_id INTEGER,
            plaid_account_id INTEGER,
            status TEXT,
            parent_id INTEGER,
            is_group INTEGER NOT NULL DEFAULT 0,
            group_id INTEGER,
            tags TEXT,
            external_id TEXT,
            original_name TEXT,
            recurring_id INTEGER,
            recurring_payee TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_lm_transactions_date ON lm_transactions(date);
          CREATE INDEX IF NOT EXISTS idx_lm_transactions_category ON lm_transactions(category_id);
        `,
      },
      {
        version: 3,
        name: "create_assets",
        up: `
          CREATE TABLE IF NOT EXISTS lm_assets (
            id INTEGER PRIMARY KEY,
            type_name TEXT NOT NULL,
            subtype_name TEXT,
            name TEXT NOT NULL,
            display_name TEXT,
            balance TEXT NOT NULL,
            balance_as_of TEXT,
            closed_on TEXT,
            currency TEXT NOT NULL,
            institution_name TEXT,
            exclude_transactions INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            to_base REAL
          )
        `,
      },
      {
        version: 4,
        name: "create_plaid_accounts",
        up: `
          CREATE TABLE IF NOT EXISTS lm_plaid_accounts (
            id INTEGER PRIMARY KEY,
            date_linked TEXT,
            name TEXT NOT NULL,
            display_name TEXT,
            type TEXT,
            subtype TEXT,
            mask TEXT,
            institution_name TEXT,
            status TEXT,
            last_import TEXT,
            balance TEXT NOT NULL,
            currency TEXT NOT NULL,
            balance_last_update TEXT,
            "limit" REAL,
            to_base REAL
          )
        `,
      },
      {
        version: 5,
        name: "create_recurring",
        up: `
          CREATE TABLE IF NOT EXISTS lm_recurring (
            id INTEGER PRIMARY KEY,
            start_date TEXT NOT NULL,
            end_date TEXT,
            payee TEXT NOT NULL,
            currency TEXT NOT NULL,
            amount TEXT NOT NULL,
            to_base REAL,
            cadence TEXT,
            description TEXT,
            billing_date TEXT,
            type TEXT,
            original_name TEXT,
            source TEXT,
            plaid_account_id INTEGER,
            asset_id INTEGER,
            category_id INTEGER
          )
        `,
      },
    ];
  }

  private async apiRequest<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(`${API_BASE}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Lunch Money API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async sync(db: SqliteDatabase): Promise<SyncResult> {
    let totalRecords = 0;
    const errors: string[] = [];

    // Sync categories
    try {
      console.log("  Fetching categories...");
      const { categories } = await this.apiRequest<{ categories: LunchMoneyCategory[] }>(
        "/categories",
      );
      db.bulkInsert(
        "lm_categories",
        categories.map((cat) => ({
          id: cat.id,
          name: cat.name,
          description: cat.description,
          is_income: cat.is_income ? 1 : 0,
          exclude_from_budget: cat.exclude_from_budget ? 1 : 0,
          exclude_from_totals: cat.exclude_from_totals ? 1 : 0,
          is_group: cat.is_group ? 1 : 0,
          group_id: cat.group_id,
          order: cat.order,
          archived: cat.archived ? 1 : 0,
          created_at: cat.created_at,
        })),
      );
      totalRecords += categories.length;
      console.log(`    ${categories.length} categories synced`);
    } catch (error) {
      errors.push(`Categories: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync transactions (last 2 years by default)
    try {
      console.log("  Fetching transactions...");
      const startDate = new Date();
      startDate.setFullYear(startDate.getFullYear() - 2);

      const { transactions } = await this.apiRequest<{ transactions: LunchMoneyTransaction[] }>(
        "/transactions",
        {
          start_date: startDate.toISOString().split("T")[0],
          end_date: new Date().toISOString().split("T")[0],
          debit_as_negative: "true",
        },
      );

      db.bulkInsert(
        "lm_transactions",
        transactions.map((tx) => ({
          id: tx.id,
          date: tx.date,
          payee: tx.payee,
          amount: tx.amount,
          currency: tx.currency,
          to_base: tx.to_base,
          notes: tx.notes,
          category_id: tx.category_id,
          category_name: tx.category_name,
          category_group_id: tx.category_group_id,
          category_group_name: tx.category_group_name,
          asset_id: tx.asset_id,
          plaid_account_id: tx.plaid_account_id,
          status: tx.status,
          parent_id: tx.parent_id,
          is_group: tx.is_group ? 1 : 0,
          group_id: tx.group_id,
          tags: tx.tags ? JSON.stringify(tx.tags) : null,
          external_id: tx.external_id,
          original_name: tx.original_name,
          recurring_id: tx.recurring_id,
          recurring_payee: tx.recurring_payee,
        })),
      );
      totalRecords += transactions.length;
      console.log(`    ${transactions.length} transactions synced`);
    } catch (error) {
      errors.push(`Transactions: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync assets
    try {
      console.log("  Fetching assets...");
      const { assets } = await this.apiRequest<{ assets: LunchMoneyAsset[] }>("/assets");
      db.bulkInsert(
        "lm_assets",
        assets.map((asset) => ({
          id: asset.id,
          type_name: asset.type_name,
          subtype_name: asset.subtype_name,
          name: asset.name,
          display_name: asset.display_name,
          balance: asset.balance,
          balance_as_of: asset.balance_as_of,
          closed_on: asset.closed_on,
          currency: asset.currency,
          institution_name: asset.institution_name,
          exclude_transactions: asset.exclude_transactions ? 1 : 0,
          created_at: asset.created_at,
          to_base: asset.to_base,
        })),
      );
      totalRecords += assets.length;
      console.log(`    ${assets.length} assets synced`);
    } catch (error) {
      errors.push(`Assets: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync Plaid accounts
    try {
      console.log("  Fetching Plaid accounts...");
      const { plaid_accounts } = await this.apiRequest<{
        plaid_accounts: LunchMoneyPlaidAccount[];
      }>("/plaid_accounts");
      db.bulkInsert(
        "lm_plaid_accounts",
        plaid_accounts.map((account) => ({
          id: account.id,
          date_linked: account.date_linked,
          name: account.name,
          display_name: account.display_name,
          type: account.type,
          subtype: account.subtype,
          mask: account.mask,
          institution_name: account.institution_name,
          status: account.status,
          last_import: account.last_import,
          balance: account.balance,
          currency: account.currency,
          balance_last_update: account.balance_last_update,
          limit: account.limit,
          to_base: account.to_base,
        })),
      );
      totalRecords += plaid_accounts.length;
      console.log(`    ${plaid_accounts.length} Plaid accounts synced`);
    } catch (error) {
      errors.push(`Plaid accounts: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync recurring items
    try {
      console.log("  Fetching recurring items...");
      const startDate = new Date();
      const endDate = new Date();
      endDate.setMonth(endDate.getMonth() + 1);

      const response = await this.apiRequest<{
        recurring_items?: LunchMoneyRecurringItem[];
      }>("/recurring_items", {
        start_date: startDate.toISOString().split("T")[0],
        end_date: endDate.toISOString().split("T")[0],
        debit_as_negative: "true",
      });

      const recurring_items = response.recurring_items ?? [];

      if (recurring_items.length > 0) {
        db.bulkInsert(
          "lm_recurring",
          recurring_items.map((item) => ({
            id: item.id,
            start_date: item.start_date,
            end_date: item.end_date,
            payee: item.payee,
            currency: item.currency,
            amount: item.amount,
            to_base: item.to_base,
            cadence: item.cadence,
            description: item.description,
            billing_date: item.billing_date,
            type: item.type,
            original_name: item.original_name,
            source: item.source,
            plaid_account_id: item.plaid_account_id,
            asset_id: item.asset_id,
            category_id: item.category_id,
          })),
        );
        totalRecords += recurring_items.length;
      }
      console.log(`    ${recurring_items.length} recurring items synced`);
    } catch (error) {
      errors.push(`Recurring items: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      success: errors.length === 0,
      recordsSynced: totalRecords,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// Register the integration
integrationRegistry.register(new LunchMoneyIntegration());
