import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE "asset_pet" ADD COLUMN "trackId" uuid;
    UPDATE "asset_pet" SET "trackId" = id;
    ALTER TABLE "asset_pet" ALTER COLUMN "trackId" SET NOT NULL;
    CREATE INDEX "asset_pet_assetId_trackId_idx" ON "asset_pet" ("assetId", "trackId");
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP INDEX "asset_pet_assetId_trackId_idx";
    ALTER TABLE "asset_pet" DROP COLUMN "trackId";
  `.execute(db);
}
