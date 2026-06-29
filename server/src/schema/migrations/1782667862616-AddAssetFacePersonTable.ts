import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE TABLE "asset_face_person" (
  "faceId" uuid NOT NULL,
  "personId" uuid NOT NULL,
  "sourceType" sourcetype NOT NULL DEFAULT 'machine-learning',
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "asset_face_person_faceId_fkey" FOREIGN KEY ("faceId") REFERENCES "asset_face" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_face_person_personId_fkey" FOREIGN KEY ("personId") REFERENCES "person" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_face_person_pkey" PRIMARY KEY ("faceId", "personId")
);`.execute(db);
  await sql`CREATE INDEX "asset_face_person_faceId_idx" ON "asset_face_person" ("faceId");`.execute(db);
  await sql`CREATE INDEX "asset_face_person_personId_idx" ON "asset_face_person" ("personId");`.execute(db);
  await sql`CREATE INDEX "asset_face_person_updateId_idx" ON "asset_face_person" ("updateId");`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "asset_face_person_updatedAt"
  BEFORE UPDATE ON "asset_face_person"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_asset_face_person_updatedAt', '{"type":"trigger","name":"asset_face_person_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"asset_face_person_updatedAt\\"\\n  BEFORE UPDATE ON \\"asset_face_person\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP TABLE "asset_face_person";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_asset_face_person_updatedAt';`.execute(db);
}
