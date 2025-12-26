import { Integration, SyncResult, integrationRegistry } from "../core/integration.js";
import { SqliteDatabase, Migration } from "../db/sqlite.js";
import { startOAuthFlow, refreshAccessToken, updateEnvFile, OAuthTokens } from "../core/oauth.js";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

interface GoogleCalendar {
  id: string;
  summary: string;
  description?: string;
  timeZone?: string;
  colorId?: string;
  backgroundColor?: string;
  foregroundColor?: string;
  accessRole: string;
  primary?: boolean;
}

interface GoogleCalendarListResponse {
  kind: string;
  etag: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: GoogleCalendar[];
}

interface GoogleEventDateTime {
  date?: string; // For all-day events (YYYY-MM-DD)
  dateTime?: string; // For timed events (RFC3339)
  timeZone?: string;
}

interface GoogleEventAttendee {
  email: string;
  displayName?: string;
  responseStatus?: string;
  organizer?: boolean;
  self?: boolean;
}

interface GoogleEvent {
  id: string;
  status: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  summary?: string;
  description?: string;
  location?: string;
  creator?: {
    email?: string;
    displayName?: string;
  };
  organizer?: {
    email?: string;
    displayName?: string;
  };
  start: GoogleEventDateTime;
  end: GoogleEventDateTime;
  recurringEventId?: string;
  attendees?: GoogleEventAttendee[];
}

interface GoogleEventsListResponse {
  kind: string;
  etag: string;
  summary: string;
  updated: string;
  timeZone: string;
  accessRole: string;
  nextPageToken?: string;
  nextSyncToken?: string;
  items: GoogleEvent[];
}

class GoogleCalendarIntegration implements Integration {
  name = "google-calendar";
  displayName = "Google Calendar";

  private get clientId(): string | undefined {
    return process.env.GOOGLE_CLIENT_ID;
  }

  private get clientSecret(): string | undefined {
    return process.env.GOOGLE_CLIENT_SECRET;
  }

  private get accessToken(): string | undefined {
    return process.env.GOOGLE_ACCESS_TOKEN;
  }

  private get refreshToken(): string | undefined {
    return process.env.GOOGLE_REFRESH_TOKEN;
  }

  isConfigured(): boolean {
    return !!this.clientId && !!this.clientSecret && !!this.accessToken;
  }

  canAuthenticate(): boolean {
    return !!this.clientId && !!this.clientSecret;
  }

  getMigrations(): Migration[] {
    return [
      {
        version: 200,
        name: "create_calendars",
        up: `
          CREATE TABLE IF NOT EXISTS gcal_calendars (
            id TEXT PRIMARY KEY,
            summary TEXT NOT NULL,
            description TEXT,
            time_zone TEXT,
            color_id TEXT,
            background_color TEXT,
            foreground_color TEXT,
            access_role TEXT,
            primary_calendar INTEGER DEFAULT 0
          )
        `,
      },
      {
        version: 201,
        name: "create_events",
        up: `
          CREATE TABLE IF NOT EXISTS gcal_events (
            id TEXT PRIMARY KEY,
            calendar_id TEXT NOT NULL,
            status TEXT,
            summary TEXT,
            description TEXT,
            location TEXT,
            creator_email TEXT,
            organizer_email TEXT,
            start_datetime TEXT,
            end_datetime TEXT,
            start_date TEXT,
            end_date TEXT,
            time_zone TEXT,
            recurring_event_id TEXT,
            html_link TEXT,
            created TEXT,
            updated TEXT,
            FOREIGN KEY (calendar_id) REFERENCES gcal_calendars(id)
          );
          CREATE INDEX IF NOT EXISTS idx_gcal_events_calendar ON gcal_events(calendar_id);
          CREATE INDEX IF NOT EXISTS idx_gcal_events_start ON gcal_events(start_datetime);
        `,
      },
      {
        version: 202,
        name: "create_attendees",
        up: `
          CREATE TABLE IF NOT EXISTS gcal_attendees (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_id TEXT NOT NULL,
            email TEXT NOT NULL,
            display_name TEXT,
            response_status TEXT,
            is_organizer INTEGER DEFAULT 0,
            is_self INTEGER DEFAULT 0,
            FOREIGN KEY (event_id) REFERENCES gcal_events(id),
            UNIQUE(event_id, email)
          );
          CREATE INDEX IF NOT EXISTS idx_gcal_attendees_event ON gcal_attendees(event_id);
          CREATE INDEX IF NOT EXISTS idx_gcal_attendees_email ON gcal_attendees(email);
        `,
      },
    ];
  }

  /**
   * Start OAuth flow to authenticate with Google Calendar
   */
  async authenticate(): Promise<OAuthTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "Google client ID and secret are required. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.",
      );
    }

    const tokens = await startOAuthFlow({
      serviceName: "Google Calendar",
      authorizationUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scopes: ["https://www.googleapis.com/auth/calendar.readonly"],
      additionalParams: {
        access_type: "offline",
        prompt: "consent", // Force consent to get refresh token
      },
    });

    // Save tokens to .env file
    const envUpdates: Record<string, string> = {
      GOOGLE_ACCESS_TOKEN: tokens.accessToken,
    };
    if (tokens.refreshToken) {
      envUpdates.GOOGLE_REFRESH_TOKEN = tokens.refreshToken;
    }
    if (tokens.expiresAt) {
      envUpdates.GOOGLE_TOKEN_EXPIRES_AT = tokens.expiresAt.toISOString();
    }
    updateEnvFile(envUpdates);

    console.log("\n✓ Google Calendar authentication successful!");
    console.log("  Tokens saved to .env file\n");

    return tokens;
  }

  private async ensureValidToken(): Promise<string> {
    // Check if token is expired
    const expiresAt = process.env.GOOGLE_TOKEN_EXPIRES_AT;
    if (expiresAt) {
      const expiry = new Date(expiresAt);
      if (expiry <= new Date() && this.refreshToken && this.clientId && this.clientSecret) {
        console.log("  Access token expired, refreshing...");
        const tokens = await refreshAccessToken(
          TOKEN_URL,
          this.clientId,
          this.clientSecret,
          this.refreshToken,
        );

        // Update .env with new tokens
        const envUpdates: Record<string, string> = {
          GOOGLE_ACCESS_TOKEN: tokens.accessToken,
        };
        if (tokens.refreshToken) {
          envUpdates.GOOGLE_REFRESH_TOKEN = tokens.refreshToken;
        }
        if (tokens.expiresAt) {
          envUpdates.GOOGLE_TOKEN_EXPIRES_AT = tokens.expiresAt.toISOString();
        }
        updateEnvFile(envUpdates);

        console.log("  Token refreshed and saved to .env");
        return tokens.accessToken;
      }
    }

    if (!this.accessToken) {
      throw new Error("No access token available. Run 'mydata auth google-calendar' first.");
    }

    return this.accessToken;
  }

  private async apiRequest<T>(
    endpoint: string,
    accessToken: string,
    params?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const url = new URL(`${API_BASE}${endpoint}`);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Google Calendar API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async sync(db: SqliteDatabase): Promise<SyncResult> {
    const accessToken = await this.ensureValidToken();
    let totalRecords = 0;
    const errors: string[] = [];

    // Sync calendars
    let calendars: GoogleCalendar[] = [];
    try {
      console.log("  Fetching calendar list...");
      let pageToken: string | undefined;

      do {
        const response = await this.apiRequest<GoogleCalendarListResponse>(
          "/users/me/calendarList",
          accessToken,
          pageToken ? { pageToken } : {},
        );

        calendars = calendars.concat(response.items);
        pageToken = response.nextPageToken;
      } while (pageToken);

      // Insert calendars
      for (const calendar of calendars) {
        db.upsert("gcal_calendars", {
          id: calendar.id,
          summary: calendar.summary,
          description: calendar.description ?? null,
          time_zone: calendar.timeZone ?? null,
          color_id: calendar.colorId ?? null,
          background_color: calendar.backgroundColor ?? null,
          foreground_color: calendar.foregroundColor ?? null,
          access_role: calendar.accessRole,
          primary_calendar: calendar.primary ? 1 : 0,
        });
      }
      totalRecords += calendars.length;
      console.log(`    ${calendars.length} calendars synced`);
    } catch (error) {
      errors.push(`Calendars: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync events for each calendar
    for (const calendar of calendars) {
      try {
        console.log(`  Fetching events for "${calendar.summary}"...`);
        let pageToken: string | undefined;
        let allEvents: GoogleEvent[] = [];

        // Get events from the past year and future year
        const timeMin = new Date();
        timeMin.setFullYear(timeMin.getFullYear() - 1);
        const timeMax = new Date();
        timeMax.setFullYear(timeMax.getFullYear() + 1);

        do {
          const params: Record<string, string | number | boolean> = {
            maxResults: 250,
            singleEvents: true, // Expand recurring events
            orderBy: "startTime",
            timeMin: timeMin.toISOString(),
            timeMax: timeMax.toISOString(),
          };
          if (pageToken) {
            params.pageToken = pageToken;
          }

          const response = await this.apiRequest<GoogleEventsListResponse>(
            `/calendars/${encodeURIComponent(calendar.id)}/events`,
            accessToken,
            params,
          );

          allEvents = allEvents.concat(response.items);
          pageToken = response.nextPageToken;

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 100));
        } while (pageToken);

        // Insert events and attendees
        for (const event of allEvents) {
          // Insert event
          db.upsert("gcal_events", {
            id: event.id,
            calendar_id: calendar.id,
            status: event.status,
            summary: event.summary ?? null,
            description: event.description ?? null,
            location: event.location ?? null,
            creator_email: event.creator?.email ?? null,
            organizer_email: event.organizer?.email ?? null,
            start_datetime: event.start.dateTime ?? null,
            end_datetime: event.end.dateTime ?? null,
            start_date: event.start.date ?? null,
            end_date: event.end.date ?? null,
            time_zone: event.start.timeZone ?? null,
            recurring_event_id: event.recurringEventId ?? null,
            html_link: event.htmlLink ?? null,
            created: event.created ?? null,
            updated: event.updated ?? null,
          });

          // Insert attendees
          if (event.attendees && event.attendees.length > 0) {
            for (const attendee of event.attendees) {
              db.execute(
                `INSERT OR REPLACE INTO gcal_attendees 
                 (event_id, email, display_name, response_status, is_organizer, is_self)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [
                  event.id,
                  attendee.email,
                  attendee.displayName ?? null,
                  attendee.responseStatus ?? null,
                  attendee.organizer ? 1 : 0,
                  attendee.self ? 1 : 0,
                ],
              );
            }
            totalRecords += event.attendees.length;
          }
        }

        totalRecords += allEvents.length;
        console.log(`    ${allEvents.length} events synced`);
      } catch (error) {
        errors.push(
          `Events for ${calendar.summary}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    return {
      success: errors.length === 0,
      recordsSynced: totalRecords,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// Register the integration
export const googleCalendarIntegration = new GoogleCalendarIntegration();
integrationRegistry.register(googleCalendarIntegration);
