import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE "asset_pet"
      ADD COLUMN "frameTimestampMs" integer NOT NULL DEFAULT 0,
      ADD COLUMN "frameDurationMs" integer
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE "asset_pet"
      DROP COLUMN "frameDurationMs",
      DROP COLUMN "frameTimestampMs"
  `.execute(db);
}
