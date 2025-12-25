import { createServer, IncomingMessage, ServerResponse } from "http";
import { URL } from "url";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import open from "open";

export interface OAuthConfig {
  /** Name of the service (for display) */
  serviceName: string;

  /** OAuth authorization URL */
  authorizationUrl: string;

  /** OAuth token endpoint */
  tokenUrl: string;

  /** Client ID */
  clientId: string;

  /** Client secret */
  clientSecret: string;

  /** Scopes to request */
  scopes: string[];

  /** Separator for scopes (default: " " space, some APIs use ",") */
  scopeSeparator?: string;

  /** Local port for callback server */
  callbackPort?: number;

  /** Additional authorization URL parameters */
  additionalParams?: Record<string, string>;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  expiresAt?: Date;
  tokenType?: string;
  scope?: string;
}

/**
 * Start an OAuth authorization flow with a local callback server
 */
export async function startOAuthFlow(config: OAuthConfig): Promise<OAuthTokens> {
  const port = config.callbackPort || 8765;
  const redirectUri = `http://localhost:${port}/callback`;

  return new Promise((resolve, reject) => {
    const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code");
        const error = url.searchParams.get("error");
        const errorDescription = url.searchParams.get("error_description");

        if (error) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Authorization Failed</h1>
                <p>${errorDescription || error}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error(`OAuth error: ${errorDescription || error}`));
          return;
        }

        if (!code) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Missing Authorization Code</h1>
                <p>No authorization code received.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(new Error("No authorization code received"));
          return;
        }

        // Exchange code for tokens
        try {
          const tokens = await exchangeCodeForTokens(config, code, redirectUri);

          res.writeHead(200, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Authorization Successful!</h1>
                <p>${config.serviceName} has been connected.</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);

          server.close();
          resolve(tokens);
        } catch (tokenError) {
          res.writeHead(500, { "Content-Type": "text/html" });
          res.end(`
            <html>
              <body style="font-family: system-ui; padding: 40px; text-align: center;">
                <h1>Token Exchange Failed</h1>
                <p>${tokenError instanceof Error ? tokenError.message : "Unknown error"}</p>
                <p>You can close this window.</p>
              </body>
            </html>
          `);
          server.close();
          reject(tokenError);
        }
      } else {
        res.writeHead(404);
        res.end("Not found");
      }
    });

    server.listen(port, () => {
      // Build authorization URL
      const authUrl = new URL(config.authorizationUrl);
      authUrl.searchParams.set("client_id", config.clientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");

      if (config.scopes.length > 0) {
        const separator = config.scopeSeparator ?? " ";
        authUrl.searchParams.set("scope", config.scopes.join(separator));
      }

      if (config.additionalParams) {
        for (const [key, value] of Object.entries(config.additionalParams)) {
          authUrl.searchParams.set(key, value);
        }
      }

      console.log(`\nOpening browser for ${config.serviceName} authorization...`);
      console.log(`Callback server listening on http://localhost:${port}`);
      console.log(`\nIf the browser doesn't open, visit:\n${authUrl.toString()}\n`);

      open(authUrl.toString());
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    // Timeout after 5 minutes
    setTimeout(() => {
      server.close();
      reject(new Error("OAuth flow timed out after 5 minutes"));
    }, 5 * 60 * 1000);
  });
}

/**
 * Exchange an authorization code for tokens
 */
async function exchangeCodeForTokens(
  config: OAuthConfig,
  code: string,
  redirectUri: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
  });

  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope,
  };

  if (data.expires_in) {
    tokens.expiresAt = new Date(Date.now() + data.expires_in * 1000);
  }

  return tokens;
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };

  const tokens: OAuthTokens = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken, // Some providers don't return a new refresh token
    expiresIn: data.expires_in,
    tokenType: data.token_type,
    scope: data.scope,
  };

  if (data.expires_in) {
    tokens.expiresAt = new Date(Date.now() + data.expires_in * 1000);
  }

  return tokens;
}

/**
 * Update .env file with new key-value pairs.
 * Only touches lines matching the provided keys - doesn't expose other values.
 */
export function updateEnvFile(updates: Record<string, string>, envPath?: string): void {
  const filePath = envPath ?? resolve(process.cwd(), ".env");
  const keysToUpdate = Object.keys(updates);

  let lines: string[] = [];

  // Read existing file if it exists, filter out keys we're updating
  if (existsSync(filePath)) {
    const content = readFileSync(filePath, "utf-8");
    lines = content.split("\n").filter((line) => {
      // Keep lines that don't start with any of our keys
      return !keysToUpdate.some((key) => line.startsWith(`${key}=`) || line.startsWith(`${key} =`));
    });

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
  }

  // Add new values
  for (const [key, value] of Object.entries(updates)) {
    lines.push(`${key}=${value}`);
  }

  // Write back
  writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}
