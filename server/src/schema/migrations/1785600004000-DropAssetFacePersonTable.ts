import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  // People created only for faces on shared assets have no asset_face rows of their own.
  await sql`DELETE FROM "person"
    WHERE "id" IN (SELECT "personId" FROM "asset_face_person")
      AND NOT EXISTS (SELECT 1 FROM "asset_face" WHERE "asset_face"."personId" = "person"."id");`.execute(db);
  await sql`DROP TABLE "asset_face_person";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_face_person_updatedAt';`.execute(db);
}

export async function down(): Promise<void> {
  // Not implemented: shared face links were replaced by upstream cluster groups
}
