import { Integration, SyncResult, integrationRegistry } from "../core/integration.js";
import { SqliteDatabase, Migration } from "../db/sqlite.js";

const API_BASE = "https://api.hevyapp.com/v1";

interface HevySet {
    index: number;
    type: string;
    weight_kg: number | null;
    reps: number | null;
    distance_meters: number | null;
    duration_seconds: number | null;
    rpe: number | null;
    custom_metric: number | null;
}

interface HevyExercise {
    index: number;
    title: string;
    notes: string;
    exercise_template_id: string;
    supersets_id: number | null;
    sets: HevySet[];
}

interface HevyWorkout {
    id: string;
    title: string;
    routine_id: string;
    description: string;
    start_time: string;
    end_time: string;
    updated_at: string;
    created_at: string;
    exercises: HevyExercise[];
}

interface HevyWorkoutsResponse {
    page: number;
    page_count: number;
    workouts: HevyWorkout[];
}

interface HevyWorkoutCountResponse {
    workout_count: number;
}

class HevyIntegration implements Integration {
    name = "hevy";
    displayName = "Hevy";

    private get apiKey(): string | undefined {
        return process.env.HEVY_API_KEY;
    }

    isConfigured(): boolean {
        return !!this.apiKey;
    }

    getMigrations(): Migration[] {
        return [
            {
                version: 306,
                name: "recreate_tables_api_schema",
                up: `
          DROP TABLE IF EXISTS hevy_sets;
          DROP TABLE IF EXISTS hevy_exercises;
          DROP TABLE IF EXISTS hevy_workouts;
          CREATE TABLE hevy_workouts (
            id TEXT PRIMARY KEY,
            title TEXT,
            description TEXT,
            start_time TEXT NOT NULL,
            end_time TEXT,
            routine_id TEXT,
            created_at TEXT,
            updated_at TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_workouts_start_time ON hevy_workouts(start_time);
          CREATE TABLE hevy_exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workout_id TEXT NOT NULL,
            exercise_index INTEGER NOT NULL,
            title TEXT NOT NULL,
            exercise_template_id TEXT,
            superset_id INTEGER,
            notes TEXT,
            FOREIGN KEY (workout_id) REFERENCES hevy_workouts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_exercises_workout_id ON hevy_exercises(workout_id);
          CREATE TABLE hevy_sets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exercise_id INTEGER NOT NULL,
            set_index INTEGER NOT NULL,
            set_type TEXT,
            weight_kg REAL,
            reps INTEGER,
            distance_meters REAL,
            duration_seconds INTEGER,
            rpe REAL,
            custom_metric REAL,
            FOREIGN KEY (exercise_id) REFERENCES hevy_exercises(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_sets_exercise_id ON hevy_sets(exercise_id);
        `,
            },
        ];
    }

    private async apiRequest<T>(endpoint: string, params?: Record<string, string | number>): Promise<T> {
        const url = new URL(`${API_BASE}${endpoint}`);
        if (params) {
            for (const [key, value] of Object.entries(params)) {
                url.searchParams.set(key, String(value));
            }
        }

        const response = await fetch(url.toString(), {
            headers: {
                "api-key": this.apiKey!,
                accept: "application/json",
            },
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Hevy API error: ${response.status} ${errorText}`);
        }

        return response.json() as Promise<T>;
    }

    private async fetchAllWorkouts(): Promise<HevyWorkout[]> {
        const { workout_count } = await this.apiRequest<HevyWorkoutCountResponse>("/workouts/count");
        console.log(`    Total workouts in Hevy: ${workout_count}`);

        const allWorkouts: HevyWorkout[] = [];
        const pageSize = 10;
        let page = 1;

        while (true) {
            const response = await this.apiRequest<HevyWorkoutsResponse>("/workouts", {
                page,
                pageSize,
            });

            allWorkouts.push(...response.workouts);
            console.log(`    Fetched page ${page}/${response.page_count} (${response.workouts.length} workouts)`);

            if (page >= response.page_count) break;
            page++;

            // Small delay to be respectful of rate limits
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        return allWorkouts;
    }

    async sync(db: SqliteDatabase): Promise<SyncResult> {
        if (!this.apiKey) {
            return {
                success: false,
                recordsSynced: 0,
                errors: ["HEVY_API_KEY environment variable is not set. Get your API key at https://hevy.com/settings?developer (requires Hevy Pro)."],
            };
        }

        const errors: string[] = [];
        let totalRecords = 0;

        try {
            console.log("  Fetching workouts from Hevy API...");
            const workouts = await this.fetchAllWorkouts();
            console.log(`    Fetched ${workouts.length} workouts total`);

            db.transaction(() => {
                console.log("  Clearing existing workout data...");
                db.execute("DELETE FROM hevy_sets");
                db.execute("DELETE FROM hevy_exercises");
                db.execute("DELETE FROM hevy_workouts");

                console.log("  Inserting workouts...");
                db.bulkInsert(
                    "hevy_workouts",
                    workouts.map((w) => ({
                        id: w.id,
                        title: w.title || null,
                        description: w.description || null,
                        start_time: w.start_time,
                        end_time: w.end_time || null,
                        routine_id: w.routine_id || null,
                        created_at: w.created_at || null,
                        updated_at: w.updated_at || null,
                    })),
                );
                totalRecords += workouts.length;

                for (const workout of workouts) {
                    if (workout.exercises.length === 0) continue;

                    db.bulkInsert(
                        "hevy_exercises",
                        workout.exercises.map((ex) => ({
                            workout_id: workout.id,
                            exercise_index: ex.index,
                            title: ex.title,
                            exercise_template_id: ex.exercise_template_id || null,
                            superset_id: ex.supersets_id,
                            notes: ex.notes || null,
                        })),
                    );
                    totalRecords += workout.exercises.length;

                    for (const exercise of workout.exercises) {
                        const exerciseRecord = db.queryOne<{ id: number }>(
                            "SELECT id FROM hevy_exercises WHERE workout_id = ? AND exercise_index = ?",
                            [workout.id, exercise.index],
                        );

                        if (!exerciseRecord) {
                            errors.push(
                                `Could not find exercise ID for workout ${workout.id}, exercise index: ${exercise.index}`,
                            );
                            continue;
                        }

                        if (exercise.sets.length === 0) continue;

                        db.bulkInsert(
                            "hevy_sets",
                            exercise.sets.map((set) => ({
                                exercise_id: exerciseRecord.id,
                                set_index: set.index,
                                set_type: set.type || null,
                                weight_kg: set.weight_kg,
                                reps: set.reps,
                                distance_meters: set.distance_meters,
                                duration_seconds: set.duration_seconds,
                                rpe: set.rpe,
                                custom_metric: set.custom_metric,
                            })),
                        );
                        totalRecords += exercise.sets.length;
                    }
                }
            });

            console.log(`    ${totalRecords} total records inserted (workouts, exercises, and sets)`);
        } catch (error) {
            errors.push(error instanceof Error ? error.message : String(error));
        }

        return {
            success: errors.length === 0,
            recordsSynced: totalRecords,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
}

// Register the integration
export const hevyIntegration = new HevyIntegration();
integrationRegistry.register(hevyIntegration);
