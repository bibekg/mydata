import { Integration, SyncResult, integrationRegistry } from "../core/integration.js";
import { SqliteDatabase, Migration } from "../db/sqlite.js";
import { startOAuthFlow, refreshAccessToken, updateEnvFile, OAuthTokens } from "../core/oauth.js";

const API_BASE = "https://www.strava.com/api/v3";
const AUTH_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";

interface StravaAthlete {
  id: number;
  username: string | null;
  firstname: string;
  lastname: string;
  city: string | null;
  state: string | null;
  country: string | null;
  sex: string | null;
  premium: boolean;
  created_at: string;
  updated_at: string;
  profile: string | null;
  profile_medium: string | null;
  weight: number | null;
}

interface StravaActivity {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  type: string;
  sport_type: string;
  start_date: string;
  start_date_local: string;
  timezone: string;
  utc_offset: number;
  achievement_count: number;
  kudos_count: number;
  comment_count: number;
  athlete_count: number;
  photo_count: number;
  trainer: boolean;
  commute: boolean;
  manual: boolean;
  private: boolean;
  flagged: boolean;
  gear_id: string | null;
  average_speed: number;
  max_speed: number;
  average_cadence: number | null;
  average_watts: number | null;
  weighted_average_watts: number | null;
  kilojoules: number | null;
  device_watts: boolean;
  has_heartrate: boolean;
  average_heartrate: number | null;
  max_heartrate: number | null;
  max_watts: number | null;
  pr_count: number;
  suffer_score: number | null;
  calories: number | null;
  description: string | null;
  workout_type: number | null;
  start_latlng: [number, number] | null;
  end_latlng: [number, number] | null;
}

class StravaIntegration implements Integration {
  name = "strava";
  displayName = "Strava";

  private get clientId(): string | undefined {
    return process.env.STRAVA_CLIENT_ID;
  }

  private get clientSecret(): string | undefined {
    return process.env.STRAVA_CLIENT_SECRET;
  }

  private get accessToken(): string | undefined {
    return process.env.STRAVA_ACCESS_TOKEN;
  }

  private get refreshToken(): string | undefined {
    return process.env.STRAVA_REFRESH_TOKEN;
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
        version: 100,
        name: "create_athlete",
        up: `
          CREATE TABLE IF NOT EXISTS strava_athlete (
            id INTEGER PRIMARY KEY,
            username TEXT,
            firstname TEXT NOT NULL,
            lastname TEXT NOT NULL,
            city TEXT,
            state TEXT,
            country TEXT,
            sex TEXT,
            premium INTEGER NOT NULL DEFAULT 0,
            created_at TEXT,
            updated_at TEXT,
            profile TEXT,
            profile_medium TEXT,
            weight REAL
          )
        `,
      },
      {
        version: 101,
        name: "create_activities",
        up: `
          CREATE TABLE IF NOT EXISTS strava_activities (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL,
            distance REAL NOT NULL,
            moving_time INTEGER NOT NULL,
            elapsed_time INTEGER NOT NULL,
            total_elevation_gain REAL NOT NULL,
            type TEXT NOT NULL,
            sport_type TEXT NOT NULL,
            start_date TEXT NOT NULL,
            start_date_local TEXT NOT NULL,
            timezone TEXT,
            utc_offset INTEGER,
            achievement_count INTEGER DEFAULT 0,
            kudos_count INTEGER DEFAULT 0,
            comment_count INTEGER DEFAULT 0,
            athlete_count INTEGER DEFAULT 1,
            photo_count INTEGER DEFAULT 0,
            trainer INTEGER NOT NULL DEFAULT 0,
            commute INTEGER NOT NULL DEFAULT 0,
            manual INTEGER NOT NULL DEFAULT 0,
            private INTEGER NOT NULL DEFAULT 0,
            flagged INTEGER NOT NULL DEFAULT 0,
            gear_id TEXT,
            average_speed REAL,
            max_speed REAL,
            average_cadence REAL,
            average_watts REAL,
            weighted_average_watts REAL,
            kilojoules REAL,
            device_watts INTEGER DEFAULT 0,
            has_heartrate INTEGER NOT NULL DEFAULT 0,
            average_heartrate REAL,
            max_heartrate REAL,
            max_watts REAL,
            pr_count INTEGER DEFAULT 0,
            suffer_score REAL,
            calories REAL,
            description TEXT,
            workout_type INTEGER,
            start_lat REAL,
            start_lng REAL,
            end_lat REAL,
            end_lng REAL
          );
          CREATE INDEX IF NOT EXISTS idx_strava_activities_date ON strava_activities(start_date);
          CREATE INDEX IF NOT EXISTS idx_strava_activities_type ON strava_activities(type);
          CREATE INDEX IF NOT EXISTS idx_strava_activities_sport_type ON strava_activities(sport_type);
        `,
      },
    ];
  }

  /**
   * Start OAuth flow to authenticate with Strava
   */
  async authenticate(): Promise<OAuthTokens> {
    if (!this.clientId || !this.clientSecret) {
      throw new Error(
        "Strava client ID and secret are required. Set STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET.",
      );
    }

    const tokens = await startOAuthFlow({
      serviceName: "Strava",
      authorizationUrl: AUTH_URL,
      tokenUrl: TOKEN_URL,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      scopes: ["read", "activity:read_all", "profile:read_all"],
      scopeSeparator: ",", // Strava uses comma-separated scopes
      additionalParams: {
        approval_prompt: "auto",
      },
    });

    // Save tokens to .env file
    const envUpdates: Record<string, string> = {
      STRAVA_ACCESS_TOKEN: tokens.accessToken,
    };
    if (tokens.refreshToken) {
      envUpdates.STRAVA_REFRESH_TOKEN = tokens.refreshToken;
    }
    if (tokens.expiresAt) {
      envUpdates.STRAVA_TOKEN_EXPIRES_AT = tokens.expiresAt.toISOString();
    }
    updateEnvFile(envUpdates);

    console.log("\n✓ Strava authentication successful!");
    console.log("  Tokens saved to .env file\n");

    return tokens;
  }

  private async ensureValidToken(): Promise<string> {
    // Check if token is expired
    const expiresAt = process.env.STRAVA_TOKEN_EXPIRES_AT;
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
          STRAVA_ACCESS_TOKEN: tokens.accessToken,
        };
        if (tokens.refreshToken) {
          envUpdates.STRAVA_REFRESH_TOKEN = tokens.refreshToken;
        }
        if (tokens.expiresAt) {
          envUpdates.STRAVA_TOKEN_EXPIRES_AT = tokens.expiresAt.toISOString();
        }
        updateEnvFile(envUpdates);

        console.log("  Token refreshed and saved to .env");
        return tokens.accessToken;
      }
    }

    if (!this.accessToken) {
      throw new Error("No access token available. Run 'mydata auth strava' first.");
    }

    return this.accessToken;
  }

  private async apiRequest<T>(
    endpoint: string,
    accessToken: string,
    params?: Record<string, string | number>,
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
      throw new Error(`Strava API error: ${response.status} ${errorText}`);
    }

    return response.json() as Promise<T>;
  }

  async sync(db: SqliteDatabase): Promise<SyncResult> {
    const accessToken = await this.ensureValidToken();
    let totalRecords = 0;
    const errors: string[] = [];

    // Sync athlete profile
    try {
      console.log("  Fetching athlete profile...");
      const athlete = await this.apiRequest<StravaAthlete>("/athlete", accessToken);
      db.upsert("strava_athlete", {
        id: athlete.id,
        username: athlete.username,
        firstname: athlete.firstname,
        lastname: athlete.lastname,
        city: athlete.city,
        state: athlete.state,
        country: athlete.country,
        sex: athlete.sex,
        premium: athlete.premium ? 1 : 0,
        created_at: athlete.created_at,
        updated_at: athlete.updated_at,
        profile: athlete.profile,
        profile_medium: athlete.profile_medium,
        weight: athlete.weight,
      });
      totalRecords += 1;
      console.log(`    Athlete profile synced: ${athlete.firstname} ${athlete.lastname}`);
    } catch (error) {
      errors.push(`Athlete: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Sync activities
    try {
      console.log("  Fetching activities...");
      let page = 1;
      const perPage = 100;
      let allActivities: StravaActivity[] = [];

      // Get the most recent activity date from the database for incremental sync
      const lastActivity = db.queryOne<{ start_date: string }>(
        "SELECT start_date FROM strava_activities ORDER BY start_date DESC LIMIT 1",
      );
      const after = lastActivity
        ? Math.floor(new Date(lastActivity.start_date).getTime() / 1000)
        : undefined;

      while (true) {
        const activities = await this.apiRequest<StravaActivity[]>(
          "/athlete/activities",
          accessToken,
          {
            page,
            per_page: perPage,
            ...(after ? { after } : {}),
          },
        );

        if (activities.length === 0) break;

        allActivities = allActivities.concat(activities);
        console.log(`    Fetched page ${page} (${activities.length} activities)`);

        if (activities.length < perPage) break;
        page++;

        // Rate limiting: Strava allows 100 requests per 15 minutes
        // Add a small delay between pages to be safe
        await new Promise((resolve) => setTimeout(resolve, 100));
      }

      // Insert all activities
      if (allActivities.length > 0) {
        db.bulkInsert(
          "strava_activities",
          allActivities.map((activity) => ({
            id: activity.id,
            name: activity.name,
            distance: activity.distance,
            moving_time: activity.moving_time,
            elapsed_time: activity.elapsed_time,
            total_elevation_gain: activity.total_elevation_gain,
            type: activity.type,
            sport_type: activity.sport_type,
            start_date: activity.start_date,
            start_date_local: activity.start_date_local,
            timezone: activity.timezone,
            utc_offset: activity.utc_offset,
            achievement_count: activity.achievement_count,
            kudos_count: activity.kudos_count,
            comment_count: activity.comment_count,
            athlete_count: activity.athlete_count,
            photo_count: activity.photo_count,
            trainer: activity.trainer ? 1 : 0,
            commute: activity.commute ? 1 : 0,
            manual: activity.manual ? 1 : 0,
            private: activity.private ? 1 : 0,
            flagged: activity.flagged ? 1 : 0,
            gear_id: activity.gear_id,
            average_speed: activity.average_speed,
            max_speed: activity.max_speed,
            average_cadence: activity.average_cadence,
            average_watts: activity.average_watts,
            weighted_average_watts: activity.weighted_average_watts,
            kilojoules: activity.kilojoules,
            device_watts: activity.device_watts ? 1 : 0,
            has_heartrate: activity.has_heartrate ? 1 : 0,
            average_heartrate: activity.average_heartrate,
            max_heartrate: activity.max_heartrate,
            max_watts: activity.max_watts,
            pr_count: activity.pr_count,
            suffer_score: activity.suffer_score,
            calories: activity.calories,
            description: activity.description,
            workout_type: activity.workout_type,
            start_lat: activity.start_latlng?.[0] ?? null,
            start_lng: activity.start_latlng?.[1] ?? null,
            end_lat: activity.end_latlng?.[0] ?? null,
            end_lng: activity.end_latlng?.[1] ?? null,
          })),
        );
        totalRecords += allActivities.length;
      }
      console.log(`    ${allActivities.length} activities synced`);
    } catch (error) {
      errors.push(`Activities: ${error instanceof Error ? error.message : String(error)}`);
    }

    return {
      success: errors.length === 0,
      recordsSynced: totalRecords,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// Register the integration
export const stravaIntegration = new StravaIntegration();
integrationRegistry.register(stravaIntegration);
