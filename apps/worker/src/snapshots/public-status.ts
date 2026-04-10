import { AppError } from '../middleware/errors';
import { publicStatusResponseSchema, type PublicStatusResponse } from '../schemas/public-status';

const SNAPSHOT_KEY = 'status';
const MAX_AGE_SECONDS = 60;
const MAX_STALE_SECONDS = 10 * 60;

export function getSnapshotKey() {
  return SNAPSHOT_KEY;
}

export function getSnapshotMaxAgeSeconds() {
  return MAX_AGE_SECONDS;
}

function safeJsonParse(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return null;
  }
}

function looksLikeSerializedStatusPayload(text: string): boolean {
  const trimmed = text.trim();
  return (
    trimmed.startsWith('{"generated_at":') &&
    trimmed.includes('"summary"') &&
    trimmed.includes('"monitors"')
  );
}

async function readStatusSnapshotRow(
  db: D1Database,
): Promise<{ generated_at: number; body_json: string } | null> {
  return db
    .prepare(
      `
      SELECT generated_at, body_json
      FROM public_snapshots
      WHERE key = ?1
    `,
    )
    .bind(SNAPSHOT_KEY)
    .first<{ generated_at: number; body_json: string }>();
}

export async function readStatusSnapshot(
  db: D1Database,
  now: number,
): Promise<{ data: PublicStatusResponse; age: number } | null> {
  try {
    const row = await readStatusSnapshotRow(db);

    if (!row) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > MAX_AGE_SECONDS) return null;

    const parsed = safeJsonParse(row.body_json);
    const data = publicStatusResponseSchema.parse(parsed);
    return { data, age };
  } catch (err) {
    // Backward compatible: if the table doesn't exist yet or snapshot is invalid,
    // callers should fall back to live computation.
    console.warn('public snapshot: read failed, falling back to live', err);
    return null;
  }
}

export async function readStatusSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  try {
    const row = await readStatusSnapshotRow(db);
    if (!row) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > MAX_AGE_SECONDS) return null;

    if (looksLikeSerializedStatusPayload(row.body_json)) {
      return {
        bodyJson: row.body_json,
        age,
      };
    }

    const parsed = safeJsonParse(row.body_json);
    const data = publicStatusResponseSchema.parse(parsed);
    return {
      bodyJson: JSON.stringify(data),
      age,
    };
  } catch (err) {
    console.warn('public snapshot: read failed, falling back to live', err);
    return null;
  }
}

export async function readStaleStatusSnapshotJson(
  db: D1Database,
  now: number,
): Promise<{ bodyJson: string; age: number } | null> {
  try {
    const row = await readStatusSnapshotRow(db);
    if (!row) return null;

    const age = Math.max(0, now - row.generated_at);
    if (age > MAX_STALE_SECONDS) return null;

    if (looksLikeSerializedStatusPayload(row.body_json)) {
      return {
        bodyJson: row.body_json,
        age,
      };
    }

    const parsed = safeJsonParse(row.body_json);
    const data = publicStatusResponseSchema.parse(parsed);
    return {
      bodyJson: JSON.stringify(data),
      age,
    };
  } catch {
    return null;
  }
}

function statusSnapshotUpsertStatement(
  db: D1Database,
  generatedAt: number,
  bodyJson: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      `
      INSERT INTO public_snapshots (key, generated_at, body_json, updated_at)
      VALUES (?1, ?2, ?3, ?4)
      ON CONFLICT(key) DO UPDATE SET
        generated_at = excluded.generated_at,
        body_json = excluded.body_json,
        updated_at = excluded.updated_at
    `,
    )
    .bind(SNAPSHOT_KEY, generatedAt, bodyJson, now);
}

export async function writeStatusSnapshot(
  db: D1Database,
  now: number,
  payload: PublicStatusResponse,
): Promise<void> {
  const bodyJson = JSON.stringify(payload);
  await writeStatusSnapshotJson(db, now, payload.generated_at, bodyJson);
}

export async function writeStatusSnapshotJson(
  db: D1Database,
  now: number,
  generatedAt: number,
  bodyJson: string,
): Promise<void> {
  await statusSnapshotUpsertStatement(db, generatedAt, bodyJson, now).run();
}

export function applyStatusCacheHeaders(res: Response, ageSeconds: number): void {
  const remaining = Math.max(0, MAX_AGE_SECONDS - ageSeconds);

  res.headers.set(
    'Cache-Control',
    `public, max-age=${remaining}, stale-while-revalidate=0, stale-if-error=0`,
  );
}

export function toSnapshotPayload(value: unknown): PublicStatusResponse {
  const parsed = publicStatusResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(500, 'INTERNAL', 'Failed to generate status snapshot');
  }
  return parsed.data;
}
