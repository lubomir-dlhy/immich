import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    ALTER TABLE "asset_pet" ADD COLUMN "isRejected" boolean NOT NULL DEFAULT false;
    CREATE INDEX "asset_pet_assetId_isRejected_idx" ON "asset_pet" ("assetId", "isRejected");
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    DROP INDEX "asset_pet_assetId_isRejected_idx";
    ALTER TABLE "asset_pet" DROP COLUMN "isRejected";
  `.execute(db);
}
