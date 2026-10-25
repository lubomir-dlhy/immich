import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // Kept without foreign keys so upstream's person migrations can run; converted by ConvertForkSharedFaceLinks.
  await sql`CREATE TABLE "fork_shared_face_link" AS SELECT "faceId", "personId" FROM "asset_face_person";`.execute(db);
  await sql`DROP TABLE "asset_face_person";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_face_person_updatedAt';`.execute(db);
}

export async function down(): Promise<void> {
  // Not implemented: shared face links are converted to upstream person groups
}
