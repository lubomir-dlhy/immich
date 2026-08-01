import { Kysely, sql } from 'kysely';
import { getVectorExtension } from 'src/repositories/database.repository';
import { vectorIndexQuery } from 'src/utils/database';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`ALTER TABLE "asset_job_status" ADD COLUMN "petsRecognizedAt" timestamp with time zone;`.execute(db);

  await sql`CREATE TABLE "pet" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "createdAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "ownerId" uuid NOT NULL,
  "name" character varying NOT NULL DEFAULT '',
  "species" character varying NOT NULL DEFAULT 'pet',
  "isHidden" boolean NOT NULL DEFAULT false,
  "featurePetAssetId" uuid,
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "pet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "pet_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "user" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);`.execute(db);

  await sql`CREATE TABLE "asset_pet" (
  "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
  "assetId" uuid NOT NULL,
  "petId" uuid,
  "imageWidth" integer NOT NULL,
  "imageHeight" integer NOT NULL,
  "boundingBoxX1" integer NOT NULL,
  "boundingBoxY1" integer NOT NULL,
  "boundingBoxX2" integer NOT NULL,
  "boundingBoxY2" integer NOT NULL,
  "detectionScore" real NOT NULL,
  "species" character varying NOT NULL DEFAULT 'pet',
  "updatedAt" timestamp with time zone NOT NULL DEFAULT now(),
  "updateId" uuid NOT NULL DEFAULT immich_uuid_v7(),
  CONSTRAINT "asset_pet_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "asset_pet_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "asset" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_pet_petId_fkey" FOREIGN KEY ("petId") REFERENCES "pet" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);`.execute(db);

  await sql`ALTER TABLE "pet" ADD CONSTRAINT "pet_featurePetAssetId_fkey" FOREIGN KEY ("featurePetAssetId") REFERENCES "asset_pet" ("id") ON DELETE SET NULL;`.execute(
    db,
  );

  await sql`CREATE TABLE "asset_pet_identity" (
  "petAssetId" uuid NOT NULL,
  "petId" uuid NOT NULL,
  CONSTRAINT "asset_pet_identity_pkey" PRIMARY KEY ("petAssetId", "petId"),
  CONSTRAINT "asset_pet_identity_petAssetId_fkey" FOREIGN KEY ("petAssetId") REFERENCES "asset_pet" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "asset_pet_identity_petId_fkey" FOREIGN KEY ("petId") REFERENCES "pet" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);`.execute(db);

  await sql`CREATE TABLE "pet_search" (
  "petAssetId" uuid NOT NULL,
  "embedding" vector(512) NOT NULL,
  CONSTRAINT "pet_search_pkey" PRIMARY KEY ("petAssetId"),
  CONSTRAINT "pet_search_petAssetId_fkey" FOREIGN KEY ("petAssetId") REFERENCES "asset_pet" ("id") ON DELETE CASCADE
);`.execute(db);

  await sql`CREATE INDEX "pet_ownerId_idx" ON "pet" ("ownerId");`.execute(db);
  await sql`CREATE INDEX "pet_featurePetAssetId_idx" ON "pet" ("featurePetAssetId");`.execute(db);
  await sql`CREATE INDEX "pet_updateId_idx" ON "pet" ("updateId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_assetId_idx" ON "asset_pet" ("assetId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_petId_idx" ON "asset_pet" ("petId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_assetId_petId_idx" ON "asset_pet" ("assetId", "petId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_petId_assetId_idx" ON "asset_pet" ("petId", "assetId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_identity_petAssetId_idx" ON "asset_pet_identity" ("petAssetId");`.execute(db);
  await sql`CREATE INDEX "asset_pet_identity_petId_idx" ON "asset_pet_identity" ("petId");`.execute(db);

  await sql`CREATE OR REPLACE TRIGGER "pet_updatedAt"
  BEFORE UPDATE ON "pet"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "asset_pet_updatedAt"
  BEFORE UPDATE ON "asset_pet"
  FOR EACH ROW
  EXECUTE FUNCTION updated_at();`.execute(db);

  const vectorExtension = await getVectorExtension(db);
  await sql
    .raw(vectorIndexQuery({ vectorExtension, table: 'pet_search', indexName: 'pet_index' }))
    .execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES
    ('trigger_pet_updatedAt', '{"type":"trigger","name":"pet_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"pet_updatedAt\\"\\n  BEFORE UPDATE ON \\"pet\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb),
    ('trigger_asset_pet_updatedAt', '{"type":"trigger","name":"asset_pet_updatedAt","sql":"CREATE OR REPLACE TRIGGER \\"asset_pet_updatedAt\\"\\n  BEFORE UPDATE ON \\"asset_pet\\"\\n  FOR EACH ROW\\n  EXECUTE FUNCTION updated_at();"}'::jsonb),
    ('index_pet_index', '{"type":"index","name":"pet_index","sql":"CREATE INDEX \\"pet_index\\" ON \\"pet_search\\" USING hnsw (embedding vector_cosine_ops) WITH (ef_construction = 300, m = 16);"}'::jsonb);`.execute(
    db,
  );
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DELETE FROM "migration_overrides" WHERE "name" IN ('trigger_pet_updatedAt', 'trigger_asset_pet_updatedAt', 'index_pet_index');`.execute(
    db,
  );
  await sql`DROP INDEX IF EXISTS "pet_index";`.execute(db);
  await sql`DROP TABLE "pet_search";`.execute(db);
  await sql`DROP TABLE "asset_pet_identity";`.execute(db);
  await sql`ALTER TABLE "pet" DROP CONSTRAINT "pet_featurePetAssetId_fkey";`.execute(db);
  await sql`DROP TABLE "asset_pet";`.execute(db);
  await sql`DROP TABLE "pet";`.execute(db);
  await sql`ALTER TABLE "asset_job_status" DROP COLUMN "petsRecognizedAt";`.execute(db);
}
