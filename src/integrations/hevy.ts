import { Integration, SyncResult, integrationRegistry } from "../core/integration.js";
import { SqliteDatabase, Migration } from "../db/sqlite.js";
import { readFileSync, existsSync } from "fs";

interface HevyWorkoutRow {
    title: string;
    start_time: string;
    end_time: string;
    description: string;
    exercise_title: string;
    superset_id: string;
    exercise_notes: string;
    set_index: string;
    set_type: string;
    weight_lbs: string;
    reps: string;
    distance_miles: string;
    duration_seconds: string;
    rpe: string;
}

interface ParsedWorkout {
    title: string | null;
    start_time: string; // ISO 8601 format
    end_time: string | null; // ISO 8601 format
    description: string | null;
    exercises: ParsedExercise[];
}

interface ParsedExercise {
    exercise_title: string;
    superset_id: string | null;
    exercise_notes: string | null;
    sets: ParsedSet[];
}

interface ParsedSet {
    set_index: number;
    set_type: string | null;
    weight_lbs: number | null;
    reps: number | null;
    distance_miles: number | null;
    duration_seconds: number | null;
    rpe: number | null;
}

class HevyIntegration implements Integration {
    name = "hevy";
    displayName = "Hevy";

    private get csvPath(): string | undefined {
        return process.env.HEVY_CSV_PATH;
    }

    isConfigured(): boolean {
        return !!this.csvPath && existsSync(this.csvPath);
    }

    getMigrations(): Migration[] {
        return [
            {
                version: 200,
                name: "create_workouts",
                up: `
          CREATE TABLE IF NOT EXISTS hevy_workouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            start_time TEXT NOT NULL UNIQUE,
            end_time TEXT,
            description TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_workouts_start_time ON hevy_workouts(start_time);
        `,
            },
            {
                version: 201,
                name: "create_exercises",
                up: `
          CREATE TABLE IF NOT EXISTS hevy_exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workout_id INTEGER NOT NULL,
            exercise_title TEXT NOT NULL,
            superset_id TEXT,
            exercise_notes TEXT,
            FOREIGN KEY (workout_id) REFERENCES hevy_workouts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_exercises_workout_id ON hevy_exercises(workout_id);
        `,
            },
            {
                version: 202,
                name: "create_sets",
                up: `
          CREATE TABLE IF NOT EXISTS hevy_sets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exercise_id INTEGER NOT NULL,
            set_index INTEGER NOT NULL,
            set_type TEXT,
            weight_lbs REAL,
            reps INTEGER,
            distance_miles REAL,
            duration_seconds INTEGER,
            rpe INTEGER,
            FOREIGN KEY (exercise_id) REFERENCES hevy_exercises(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_sets_exercise_id ON hevy_sets(exercise_id);
        `,
            },
            {
                version: 205,
                name: "recreate_tables_correct_schema",
                up: `
          DROP TABLE IF EXISTS hevy_sets;
          DROP TABLE IF EXISTS hevy_exercises;
          DROP TABLE IF EXISTS hevy_workouts;
          CREATE TABLE hevy_workouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT,
            start_time TEXT NOT NULL UNIQUE,
            end_time TEXT,
            description TEXT
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_workouts_start_time ON hevy_workouts(start_time);
          CREATE TABLE hevy_exercises (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            workout_id INTEGER NOT NULL,
            exercise_title TEXT NOT NULL,
            superset_id TEXT,
            exercise_notes TEXT,
            FOREIGN KEY (workout_id) REFERENCES hevy_workouts(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_exercises_workout_id ON hevy_exercises(workout_id);
          CREATE TABLE hevy_sets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            exercise_id INTEGER NOT NULL,
            set_index INTEGER NOT NULL,
            set_type TEXT,
            weight_lbs REAL,
            reps INTEGER,
            distance_miles REAL,
            duration_seconds INTEGER,
            rpe INTEGER,
            FOREIGN KEY (exercise_id) REFERENCES hevy_exercises(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS idx_hevy_sets_exercise_id ON hevy_sets(exercise_id);
        `,
            },
        ];
    }

    /**
     * Parse a CSV row with proper handling of quoted fields
     */
    private parseCsvRow(line: string): string[] {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        let i = 0;

        while (i < line.length) {
            const char = line[i];
            const nextChar = i + 1 < line.length ? line[i + 1] : null;

            if (char === '"') {
                if (inQuotes && nextChar === '"') {
                    // Escaped quote
                    current += '"';
                    i += 2;
                } else {
                    // Toggle quote mode
                    inQuotes = !inQuotes;
                    i++;
                }
            } else if (char === "," && !inQuotes) {
                // End of field
                fields.push(current);
                current = "";
                i++;
            } else {
                current += char;
                i++;
            }
        }

        // Push the last field
        fields.push(current);

        return fields;
    }

    /**
     * Parse CSV file and return array of row objects
     */
    private parseCsvFile(filePath: string): HevyWorkoutRow[] {
        const content = readFileSync(filePath, "utf-8");
        const lines = content.split(/\r?\n/).filter((line) => line.trim().length > 0);

        if (lines.length === 0) {
            throw new Error("CSV file is empty");
        }

        // Parse header
        const headers = this.parseCsvRow(lines[0]);
        const headerMap = new Map<string, number>();
        headers.forEach((header, index) => {
            headerMap.set(header.trim(), index);
        });

        // Validate required headers
        const requiredHeaders = ["title", "start_time", "exercise_title", "set_index"];
        for (const header of requiredHeaders) {
            if (!headerMap.has(header)) {
                throw new Error(`Missing required CSV header: ${header}`);
            }
        }

        // Parse data rows
        const rows: HevyWorkoutRow[] = [];
        for (let i = 1; i < lines.length; i++) {
            const fields = this.parseCsvRow(lines[i]);
            if (fields.length !== headers.length) {
                console.warn(`Row ${i + 1} has ${fields.length} fields, expected ${headers.length}. Skipping.`);
                continue;
            }

            const row: HevyWorkoutRow = {
                title: fields[headerMap.get("title")!] || "",
                start_time: fields[headerMap.get("start_time")!] || "",
                end_time: fields[headerMap.get("end_time")!] || "",
                description: fields[headerMap.get("description")!] || "",
                exercise_title: fields[headerMap.get("exercise_title")!] || "",
                superset_id: fields[headerMap.get("superset_id")!] || "",
                exercise_notes: fields[headerMap.get("exercise_notes")!] || "",
                set_index: fields[headerMap.get("set_index")!] || "",
                set_type: fields[headerMap.get("set_type")!] || "",
                weight_lbs: fields[headerMap.get("weight_lbs")!] || "",
                reps: fields[headerMap.get("reps")!] || "",
                distance_miles: fields[headerMap.get("distance_miles")!] || "",
                duration_seconds: fields[headerMap.get("duration_seconds")!] || "",
                rpe: fields[headerMap.get("rpe")!] || "",
            };

            rows.push(row);
        }

        return rows;
    }

    /**
     * Parse Hevy date format "23 Dec 2025, 15:20" to ISO 8601
     */
    private parseHevyDate(dateStr: string): string | null {
        if (!dateStr || dateStr.trim() === "") {
            return null;
        }

        try {
            // Format: "23 Dec 2025, 15:20"
            // Replace comma with space for easier parsing
            const cleaned = dateStr.trim().replace(",", "");
            const parts = cleaned.split(" ");

            if (parts.length < 4) {
                throw new Error(`Invalid date format: ${dateStr}`);
            }

            const day = parseInt(parts[0], 10);
            const monthStr = parts[1];
            const year = parseInt(parts[2], 10);
            const timeStr = parts[3]; // "15:20"

            const monthMap: Record<string, number> = {
                Jan: 0,
                Feb: 1,
                Mar: 2,
                Apr: 3,
                May: 4,
                Jun: 5,
                Jul: 6,
                Aug: 7,
                Sep: 8,
                Oct: 9,
                Nov: 10,
                Dec: 11,
            };

            const month = monthMap[monthStr];
            if (month === undefined) {
                throw new Error(`Unknown month: ${monthStr}`);
            }

            const [hours, minutes] = timeStr.split(":").map((n) => parseInt(n, 10));

            const date = new Date(year, month, day, hours, minutes);
            return date.toISOString();
        } catch (error) {
            console.warn(`Failed to parse date "${dateStr}": ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    }

    /**
     * Parse numeric value, returning null for empty/invalid values
     */
    private parseNumber(value: string): number | null {
        if (!value || value.trim() === "") {
            return null;
        }
        const parsed = parseFloat(value);
        return isNaN(parsed) ? null : parsed;
    }

    /**
     * Parse integer value, returning null for empty/invalid values
     */
    private parseInt(value: string): number | null {
        if (!value || value.trim() === "") {
            return null;
        }
        const parsed = parseInt(value, 10);
        return isNaN(parsed) ? null : parsed;
    }

    /**
     * Group CSV rows into workouts and exercises
     */
    private groupWorkouts(rows: HevyWorkoutRow[]): ParsedWorkout[] {
        // Group by start_time
        const workoutMap = new Map<string, ParsedWorkout>();

        for (const row of rows) {
            const startTime = this.parseHevyDate(row.start_time);
            if (!startTime) {
                console.warn(`Skipping row with invalid start_time: ${row.start_time}`);
                continue;
            }

            // Get or create workout
            let workout = workoutMap.get(startTime);
            if (!workout) {
                workout = {
                    title: row.title || null,
                    start_time: startTime,
                    end_time: this.parseHevyDate(row.end_time),
                    description: row.description || null,
                    exercises: [],
                };
                workoutMap.set(startTime, workout);
            }

            // workout is guaranteed to be defined here after the if check
            if (!workout) {
                continue; // TypeScript guard
            }

            const currentWorkout = workout;

            // Find or create exercise
            let exercise = currentWorkout.exercises.find(
                (e) => e.exercise_title === row.exercise_title && e.superset_id === (row.superset_id || null),
            );

            if (!exercise) {
                exercise = {
                    exercise_title: row.exercise_title,
                    superset_id: row.superset_id || null,
                    exercise_notes: row.exercise_notes || null,
                    sets: [],
                };
                currentWorkout.exercises.push(exercise);
            }

            // Parse and add set
            const setIndex = this.parseInt(row.set_index);
            if (setIndex === null) {
                console.warn(`Skipping set with invalid set_index: ${row.set_index}`);
                continue;
            }

            const set: ParsedSet = {
                set_index: setIndex,
                set_type: row.set_type || null,
                weight_lbs: this.parseNumber(row.weight_lbs),
                reps: this.parseInt(row.reps),
                distance_miles: this.parseNumber(row.distance_miles),
                duration_seconds: this.parseInt(row.duration_seconds),
                rpe: this.parseInt(row.rpe),
            };

            exercise.sets.push(set);
        }

        return Array.from(workoutMap.values());
    }

    async sync(db: SqliteDatabase): Promise<SyncResult> {
        if (!this.csvPath) {
            return {
                success: false,
                recordsSynced: 0,
                errors: ["HEVY_CSV_PATH environment variable is not set"],
            };
        }

        if (!existsSync(this.csvPath)) {
            return {
                success: false,
                recordsSynced: 0,
                errors: [`CSV file not found: ${this.csvPath}`],
            };
        }

        const errors: string[] = [];
        let totalRecords = 0;

        try {
            console.log(`  Reading CSV file: ${this.csvPath}`);
            const rows = this.parseCsvFile(this.csvPath);
            console.log(`    Parsed ${rows.length} rows from CSV`);

            console.log("  Grouping workouts and exercises...");
            const workouts = this.groupWorkouts(rows);
            console.log(`    Found ${workouts.length} workouts`);

            // Use a transaction to ensure atomicity
            db.transaction(() => {
                // Delete all existing data (replace_all strategy)
                console.log("  Clearing existing workout data...");
                db.execute("DELETE FROM hevy_sets");
                db.execute("DELETE FROM hevy_exercises");
                db.execute("DELETE FROM hevy_workouts");

                // Insert workouts
                console.log("  Inserting workouts...");
                const workoutInserts = workouts.map((workout) => ({
                    title: workout.title || null,
                    start_time: workout.start_time,
                    end_time: workout.end_time || null,
                    description: workout.description || null,
                }));
                db.bulkInsert("hevy_workouts", workoutInserts);
                totalRecords += workoutInserts.length;

                // Insert exercises and sets
                for (const workout of workouts) {
                    // Get the workout ID
                    const workoutRecord = db.queryOne<{ id: number }>(
                        "SELECT id FROM hevy_workouts WHERE start_time = ?",
                        [workout.start_time],
                    );

                    if (!workoutRecord) {
                        errors.push(`Could not find workout ID for start_time: ${workout.start_time}`);
                        continue;
                    }

                    const workoutId = workoutRecord.id;

                    // Insert exercises for this workout
                    const exerciseInserts = workout.exercises.map((exercise) => ({
                        workout_id: workoutId,
                        exercise_title: exercise.exercise_title,
                        superset_id: exercise.superset_id,
                        exercise_notes: exercise.exercise_notes,
                    }));
                    db.bulkInsert("hevy_exercises", exerciseInserts);

                    // Insert sets for each exercise
                    for (const exercise of workout.exercises) {
                        const exerciseRecord = db.queryOne<{ id: number }>(
                            "SELECT id FROM hevy_exercises WHERE workout_id = ? AND exercise_title = ? AND (superset_id = ? OR (superset_id IS NULL AND ? IS NULL))",
                            [workoutId, exercise.exercise_title, exercise.superset_id, exercise.superset_id],
                        );

                        if (!exerciseRecord) {
                            errors.push(
                                `Could not find exercise ID for workout ${workoutId}, exercise: ${exercise.exercise_title}`,
                            );
                            continue;
                        }

                        const exerciseId = exerciseRecord.id;

                        const setInserts = exercise.sets.map((set) => ({
                            exercise_id: exerciseId,
                            set_index: set.set_index,
                            set_type: set.set_type,
                            weight_lbs: set.weight_lbs,
                            reps: set.reps,
                            distance_miles: set.distance_miles,
                            duration_seconds: set.duration_seconds,
                            rpe: set.rpe,
                        }));

                        if (setInserts.length > 0) {
                            db.bulkInsert("hevy_sets", setInserts);
                            totalRecords += setInserts.length;
                        }
                    }

                    totalRecords += workout.exercises.length;
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

