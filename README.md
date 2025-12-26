# MyData - Personal Data Hub

Sync personal data from various services into a local SQLite database. Query your data with SQL or let Claude help you analyze it via MCP tools.

## Supported Integrations

- **Lunch Money** - Transactions, categories, assets, recurring items
- **Strava** - Activities (runs, rides, swims, etc.)

## Setup

### 1. Install dependencies

```bash
npm install
npm run build
```

### 2. Configure environment variables

```bash
# Lunch Money - Get your API key from https://my.lunchmoney.app/developers
export LUNCHMONEY_API_KEY=your_api_key

# Strava - Create an app at https://www.strava.com/settings/api
export STRAVA_CLIENT_ID=your_client_id
export STRAVA_CLIENT_SECRET=your_client_secret

# Hevy
export HEVY_API_KEY=
```

### 3. Authenticate with OAuth services

```bash
# Start OAuth flow for Strava
npm start -- auth strava
```

## CLI Usage

```bash
# Sync all configured integrations
npm start -- sync

# Sync specific integration
npm start -- sync lunchmoney
npm start -- sync strava

# Query the database
npm start -- query "SELECT * FROM lm_transactions LIMIT 10"

# Check status
npm start -- status
```

## MCP Server

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mydata": {
      "command": "node",
      "args": ["/path/to/mydata/dist/mcp-server.js"],
      "env": {
        "MYDATA_DB_PATH": "/path/to/mydata/data/mydata.db"
      }
    }
  }
}
```

### Available MCP Tools

- `query_database` - Execute SQL queries against your data
- `list_tables` - Show all tables and their schemas
- `describe_table` - Get detailed schema for a specific table
- `get_sync_status` - Show last sync time for each integration

## Data Storage

All data is stored in a local SQLite database at `./data/mydata.db`. This file is gitignored by default.

