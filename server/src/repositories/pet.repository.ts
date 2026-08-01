import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, sql, Updateable } from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetFileType, AssetVisibility, VectorIndex } from 'src/enum';
import { probes } from 'src/repositories/database.repository';
import { DB } from 'src/schema';
import { AssetPetTable } from 'src/schema/tables/asset-pet.table';
import { PetSearchTable } from 'src/schema/tables/pet-search.table';
import { PetTable } from 'src/schema/tables/pet.table';
import { withFiles } from 'src/utils/database';

export interface GetSharedPetSightingsOptions {
  assetIds?: string[];
  albumId?: string;
  ownerId?: string;
}

@Injectable()
export class PetRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  streamAssetsForDetection(force?: boolean) {
    return this.db
      .selectFrom('asset')
      .innerJoin('asset_job_status as job_status', 'job_status.assetId', 'asset.id')
      .select('asset.id')
      .where('asset.deletedAt', 'is', null)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('asset_file')
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .where('asset_file.type', '=', AssetFileType.Preview),
        ),
      )
      .$if(force === false, (qb) => qb.where('job_status.petsRecognizedAt', 'is', null))
      .orderBy('asset.fileCreatedAt', 'desc')
      .stream();
  }

  getAssetForDetection(id: string) {
    return this.db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.visibility',
        'asset.fileCreatedAt',
        'asset.type',
        'asset.originalPath',
        'asset.duration',
      ])
      .select((eb) => withFiles(eb, AssetFileType.Preview))
      .select((eb) =>
        jsonArrayFrom(
          eb.selectFrom('asset_pet').selectAll('asset_pet').whereRef('asset_pet.assetId', '=', 'asset.id'),
        ).as('pets'),
      )
      .where('asset.id', '=', id)
      .executeTakeFirst();
  }

  async replaceAssetPets(
    assetId: string,
    sightings: Array<Insertable<AssetPetTable> & { id: string }>,
    embeddings: PetSearchTable[],
    options: { discardRejected: boolean },
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      let deleteQuery = trx.deleteFrom('asset_pet').where('assetId', '=', assetId);
      if (!options.discardRejected) {
        // Automatic processing keeps explicit "not a pet" decisions. A
        // manual refresh intentionally resets them and reruns the pipeline.
        deleteQuery = deleteQuery.where('isRejected', '=', false);
      }
      await deleteQuery.execute();
      if (sightings.length > 0) {
        await trx.insertInto('asset_pet').values(sightings).execute();
      }
      if (embeddings.length > 0) {
        await trx.insertInto('pet_search').values(embeddings).execute();
      }
    });
  }

  async createSighting(
    sighting: Insertable<AssetPetTable> & { id: string; petId: string },
    embedding: PetSearchTable,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('asset_pet').values(sighting).execute();
      await trx.insertInto('pet_search').values(embedding).execute();
      await trx
        .updateTable('pet')
        .set((eb) => ({ featurePetAssetId: eb.fn.coalesce('featurePetAssetId', eb.val(sighting.id)) }))
        .where('id', '=', sighting.petId)
        .execute();
    });
  }

  getSightingForRecognition(id: string) {
    return this.db
      .selectFrom('asset_pet')
      .selectAll('asset_pet')
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('asset')
            .select(['asset.ownerId', 'asset.fileCreatedAt', 'asset.visibility'])
            .whereRef('asset.id', '=', 'asset_pet.assetId'),
        ).as('asset'),
      )
      .select((eb) =>
        jsonObjectFrom(
          eb.selectFrom('pet_search').selectAll('pet_search').whereRef('pet_search.petAssetId', '=', 'asset_pet.id'),
        ).as('petSearch'),
      )
      .where('asset_pet.id', '=', id)
      .where('asset_pet.isRejected', '=', false)
      .executeTakeFirst();
  }

  getAllUnassigned() {
    return this.db
      .selectFrom('asset_pet')
      .distinctOn(['asset_pet.assetId', 'asset_pet.trackId'])
      .select('asset_pet.id')
      .where('asset_pet.petId', 'is', null)
      .where('asset_pet.isRejected', '=', false)
      .orderBy('asset_pet.assetId')
      .orderBy('asset_pet.trackId')
      .orderBy('asset_pet.updatedAt', 'desc')
      .stream();
  }

  getSightingsForSharedRecognition(options: GetSharedPetSightingsOptions = {}) {
    return this.db
      .selectFrom('asset_pet')
      .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
      .select('asset_pet.id')
      .where('asset_pet.isRejected', '=', false)
      .$if(options.assetIds !== undefined, (qb) => qb.where('asset_pet.assetId', 'in', options.assetIds!))
      .$if(!!options.albumId, (qb) =>
        qb.where((eb) =>
          eb.exists(
            eb
              .selectFrom('album_asset')
              .whereRef('album_asset.assetId', '=', 'asset.id')
              .where('album_asset.albumId', '=', options.albumId!)
              .select('album_asset.assetId'),
          ),
        ),
      )
      .$if(!!options.ownerId, (qb) => qb.where('asset.ownerId', '=', options.ownerId!))
      .where((eb) =>
        eb.or([
          eb.exists(
            eb
              .selectFrom('album_asset')
              .innerJoin('album', (join) =>
                join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
              )
              .innerJoin('album_user', 'album_user.albumId', 'album.id')
              .whereRef('album_asset.assetId', '=', 'asset.id')
              .whereRef('album_user.userId', '!=', 'asset.ownerId')
              .select('album_asset.assetId'),
          ),
          eb.exists(
            eb
              .selectFrom('partner')
              .whereRef('partner.sharedById', '=', 'asset.ownerId')
              .whereRef('partner.sharedWithId', '!=', 'asset.ownerId')
              .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Hidden])
              .select('partner.sharedById'),
          ),
        ]),
      )
      .stream();
  }

  async search(
    ownerId: string,
    embedding: string,
    options: { maxDistance: number; numResults: number; species: string },
  ) {
    return this.db.transaction().execute(async (trx) => {
      await sql`set local vchordrq.probes = ${sql.lit(probes[VectorIndex.Pet])}`.execute(trx);
      return trx
        .with('matches', (qb) =>
          qb
            .selectFrom('asset_pet')
            .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
            .innerJoin('pet_search', 'pet_search.petAssetId', 'asset_pet.id')
            .select([
              'asset_pet.id',
              'asset_pet.assetId',
              'asset_pet.petId',
              sql<number>`pet_search.embedding <=> ${embedding}`.as('distance'),
            ])
            .distinctOn('asset_pet.assetId')
            .where('asset.ownerId', '=', ownerId)
            .where('asset_pet.species', '=', options.species)
            .where('asset_pet.isRejected', '=', false)
            .where('asset.deletedAt', 'is', null)
            .orderBy('asset_pet.assetId')
            .orderBy('distance'),
        )
        .selectFrom('matches')
        .select(['matches.id', 'matches.petId', 'matches.distance'])
        .where('matches.distance', '<=', options.maxDistance)
        .orderBy('matches.distance')
        .limit(options.numResults)
        .execute();
    });
  }

  async getTrackEmbedding(assetId: string, trackId: string): Promise<string | undefined> {
    const { rows } = await sql<{ embedding: string | null }>`
      SELECT avg(pet_search.embedding)::text AS embedding
      FROM asset_pet
      INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet.id
      WHERE asset_pet."assetId" = ${assetId}
        AND asset_pet."trackId" = ${trackId}
        AND asset_pet."isRejected" = false
    `.execute(this.db);
    return rows[0]?.embedding ?? undefined;
  }

  async getTrackPetId(assetId: string, trackId: string): Promise<string | undefined> {
    const result = await this.db
      .selectFrom('asset_pet')
      .select('asset_pet.petId')
      .where('asset_pet.assetId', '=', assetId)
      .where('asset_pet.trackId', '=', trackId)
      .where('asset_pet.petId', 'is not', null)
      .where('asset_pet.isRejected', '=', false)
      .limit(1)
      .executeTakeFirst();
    return result?.petId ?? undefined;
  }

  async searchCentroids(
    ownerId: string,
    species: string,
    embedding: string,
    maxDistance: number,
  ): Promise<{ petId: string; distance: number } | undefined> {
    const candidates = await this.searchCentroidCandidates(ownerId, species, embedding, maxDistance, 1);
    return candidates.at(0);
  }

  async searchCentroidCandidates(
    ownerId: string,
    species: string,
    embedding: string,
    maxDistance: number,
    limit: number,
  ): Promise<Array<{ petId: string; distance: number }>> {
    const { rows } = await sql<{ petId: string; distance: number }>`
      WITH assignments AS (
        SELECT asset_pet."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet.id
        WHERE asset_pet."petId" IS NOT NULL
          AND asset_pet."isRejected" = false
        UNION ALL
        SELECT asset_pet_identity."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet_identity
        INNER JOIN asset_pet ON asset_pet.id = asset_pet_identity."petAssetId"
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet_identity."petAssetId"
        WHERE asset_pet."isRejected" = false
      ),
      asset_embeddings AS (
        SELECT "petId", "assetId", avg(embedding) AS embedding
        FROM assignments
        GROUP BY "petId", "assetId"
      ),
      centroids AS (
        SELECT
          pet.id AS "petId",
          CASE
            -- Once a pet is named, keep automatic recognition anchored to the
            -- sighting the user named instead of letting later matches move
            -- the centroid toward another similar-looking animal.
            WHEN pet.name <> '' THEN COALESCE(
              feature_search.embedding,
              (SELECT avg(asset_embeddings.embedding) FROM asset_embeddings WHERE asset_embeddings."petId" = pet.id)
            )
            ELSE COALESCE(
              (SELECT avg(asset_embeddings.embedding) FROM asset_embeddings WHERE asset_embeddings."petId" = pet.id),
              feature_search.embedding
            )
          END AS centroid
        FROM pet
        LEFT JOIN pet_search AS feature_search ON feature_search."petAssetId" = pet."featurePetAssetId"
        WHERE pet."ownerId" = ${ownerId}
          AND pet.species = ${species}
      ),
      ranked AS (
        SELECT "petId", centroid <=> ${embedding} AS distance
        FROM centroids
        WHERE centroid IS NOT NULL
      )
      SELECT "petId", distance
      FROM ranked
      WHERE distance <= ${maxDistance}
      ORDER BY distance
      LIMIT ${limit}
    `.execute(this.db);

    return rows;
  }

  async searchSuggestionCandidates(
    ownerId: string,
    species: string,
    embedding: string,
    maxDistance: number,
    limit: number,
  ): Promise<Array<{ petId: string; distance: number }>> {
    const { rows } = await sql<{ petId: string; distance: number }>`
      WITH assignments AS (
        SELECT asset_pet."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet.id
        WHERE asset_pet."petId" IS NOT NULL
          AND asset_pet."isRejected" = false
        UNION ALL
        SELECT asset_pet_identity."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet_identity
        INNER JOIN asset_pet ON asset_pet.id = asset_pet_identity."petAssetId"
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet_identity."petAssetId"
        WHERE asset_pet."isRejected" = false
      ),
      asset_embeddings AS (
        -- Videos can contain many samples of the same appearance. Average per
        -- media first so a long video cannot dominate the identity score.
        SELECT assignments."petId", assignments."assetId", avg(assignments.embedding) AS embedding
        FROM assignments
        INNER JOIN pet ON pet.id = assignments."petId"
        WHERE pet."ownerId" = ${ownerId}
          AND pet.species = ${species}
        GROUP BY assignments."petId", assignments."assetId"
      ),
      nearest_examples AS (
        SELECT
          "petId",
          embedding <=> ${embedding} AS distance,
          row_number() OVER (PARTITION BY "petId" ORDER BY embedding <=> ${embedding}) AS example_rank
        FROM asset_embeddings
      ),
      ranked AS (
        -- Manual suggestions need to tolerate pose, scale and camera changes.
        -- The closest three distinct media examples are substantially more
        -- representative than a named pet's single featured image.
        SELECT "petId", avg(distance) AS distance
        FROM nearest_examples
        WHERE example_rank <= 3
        GROUP BY "petId"
      )
      SELECT "petId", distance
      FROM ranked
      WHERE distance <= ${maxDistance}
      ORDER BY distance
      LIMIT ${limit}
    `.execute(this.db);

    return rows;
  }

  async getClusterCentroids(ownerId: string): Promise<Array<{ petId: string; embedding: string }>> {
    const { rows } = await sql<{ petId: string; embedding: string }>`
      WITH assignments AS (
        SELECT asset_pet."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet.id
        WHERE asset_pet."petId" IS NOT NULL
          AND asset_pet."isRejected" = false
        UNION ALL
        SELECT asset_pet_identity."petId", asset_pet."assetId", pet_search.embedding
        FROM asset_pet_identity
        INNER JOIN asset_pet ON asset_pet.id = asset_pet_identity."petAssetId"
        INNER JOIN pet_search ON pet_search."petAssetId" = asset_pet_identity."petAssetId"
        WHERE asset_pet."isRejected" = false
      ),
      asset_embeddings AS (
        SELECT "petId", "assetId", avg(embedding) AS embedding
        FROM assignments
        GROUP BY "petId", "assetId"
      )
      SELECT
        pet.id AS "petId",
        COALESCE(
          (SELECT avg(asset_embeddings.embedding) FROM asset_embeddings WHERE asset_embeddings."petId" = pet.id),
          feature_search.embedding
        )::text AS embedding
      FROM pet
      LEFT JOIN pet_search AS feature_search ON feature_search."petAssetId" = pet."featurePetAssetId"
      WHERE pet."ownerId" = ${ownerId}
        AND (
          feature_search.embedding IS NOT NULL
          OR EXISTS (SELECT 1 FROM asset_embeddings WHERE asset_embeddings."petId" = pet.id)
        )
    `.execute(this.db);

    return rows;
  }

  create(data: Insertable<PetTable>) {
    return this.db.insertInto('pet').values(data).returningAll().executeTakeFirstOrThrow();
  }

  async update(data: Updateable<PetTable> & { id: string }) {
    const { id, ...update } = data;
    return this.db.transaction().execute(async (trx) => {
      if (update.species) {
        await trx
          .updateTable('asset_pet')
          .set({ species: update.species })
          .where((eb) =>
            eb.or([
              eb('asset_pet.petId', '=', id),
              eb.exists(
                eb
                  .selectFrom('asset_pet_identity')
                  .select('asset_pet_identity.petAssetId')
                  .whereRef('asset_pet_identity.petAssetId', '=', 'asset_pet.id')
                  .where('asset_pet_identity.petId', '=', id),
              ),
            ]),
          )
          .execute();
      }

      return trx.updateTable('pet').set(update).where('id', '=', id).returningAll().executeTakeFirstOrThrow();
    });
  }

  async merge(targetId: string, sourceIds: string[]): Promise<void> {
    if (sourceIds.length === 0) {
      return;
    }

    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('pet')
        .set((eb) => ({
          featurePetAssetId: eb.fn.coalesce(
            'featurePetAssetId',
            eb
              .selectFrom('pet as source')
              .select('source.featurePetAssetId')
              .where('source.id', 'in', sourceIds)
              .where('source.featurePetAssetId', 'is not', null)
              .limit(1),
          ),
        }))
        .where('id', '=', targetId)
        .execute();

      await trx.updateTable('asset_pet').set({ petId: targetId }).where('petId', 'in', sourceIds).execute();

      await trx
        .insertInto('asset_pet_identity')
        .columns(['petAssetId', 'petId'])
        .expression((eb) =>
          eb
            .selectFrom('asset_pet_identity')
            .select(['petAssetId', eb.val(targetId).as('petId')])
            .where('petId', 'in', sourceIds),
        )
        .onConflict((oc) => oc.columns(['petAssetId', 'petId']).doNothing())
        .execute();
      await trx.deleteFrom('asset_pet_identity').where('petId', 'in', sourceIds).execute();
      await trx.deleteFrom('pet').where('id', 'in', sourceIds).execute();
    });
  }

  async hasSightings(petId: string, assetIds: string[]): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset_pet')
      .select('asset_pet.id')
      .where('asset_pet.assetId', 'in', assetIds)
      .where('asset_pet.isRejected', '=', false)
      .where((eb) =>
        eb.or([
          eb('asset_pet.petId', '=', petId),
          eb.exists(
            eb
              .selectFrom('asset_pet_identity')
              .select('asset_pet_identity.petAssetId')
              .whereRef('asset_pet_identity.petAssetId', '=', 'asset_pet.id')
              .where('asset_pet_identity.petId', '=', petId),
          ),
        ]),
      )
      .limit(1)
      .executeTakeFirst();
    return !!row;
  }

  async reassignSightings(sourceId: string, targetId: string, assetIds: string[]): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable('asset_pet')
        .set({ petId: targetId })
        .where('petId', '=', sourceId)
        .where('assetId', 'in', assetIds)
        .where('isRejected', '=', false)
        .execute();

      await trx
        .insertInto('asset_pet_identity')
        .columns(['petAssetId', 'petId'])
        .expression((eb) =>
          eb
            .selectFrom('asset_pet_identity')
            .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
            .select(['asset_pet_identity.petAssetId', eb.val(targetId).as('petId')])
            .where('asset_pet_identity.petId', '=', sourceId)
            .where('asset_pet.assetId', 'in', assetIds)
            .where('asset_pet.isRejected', '=', false),
        )
        .onConflict((oc) => oc.columns(['petAssetId', 'petId']).doNothing())
        .execute();

      await trx
        .deleteFrom('asset_pet_identity')
        .where('petId', '=', sourceId)
        .where(
          'petAssetId',
          'in',
          trx.selectFrom('asset_pet').select('asset_pet.id').where('asset_pet.assetId', 'in', assetIds),
        )
        .execute();
    });
  }

  async assign(petAssetId: string, petId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const sighting = await trx
        .selectFrom('asset_pet')
        .select(['assetId', 'trackId'])
        .where('id', '=', petAssetId)
        .executeTakeFirst();
      if (!sighting) {
        return;
      }
      await trx
        .updateTable('asset_pet')
        .set({ petId })
        .where('assetId', '=', sighting.assetId)
        .where('trackId', '=', sighting.trackId)
        .execute();
      await trx
        .updateTable('pet')
        .set((eb) => ({ featurePetAssetId: eb.fn.coalesce('featurePetAssetId', eb.val(petAssetId)) }))
        .where('id', '=', petId)
        .execute();
    });
  }

  async unassignIdentity(petAssetId: string, petId: string, ownerId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const ownedPet = trx
        .selectFrom('pet')
        .select('pet.id')
        .where('pet.id', '=', petId)
        .where('pet.ownerId', '=', ownerId);

      await trx
        .updateTable('asset_pet')
        .set({ petId: null })
        .where('asset_pet.id', '=', petAssetId)
        .where('asset_pet.petId', 'in', ownedPet)
        .execute();

      await trx
        .deleteFrom('asset_pet_identity')
        .where('asset_pet_identity.petAssetId', '=', petAssetId)
        .where('asset_pet_identity.petId', 'in', ownedPet)
        .execute();
    });
  }

  async hasIdentityForUser(petAssetId: string, userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('asset_pet_identity')
      .innerJoin('pet', 'pet.id', 'asset_pet_identity.petId')
      .where('asset_pet_identity.petAssetId', '=', petAssetId)
      .where('pet.ownerId', '=', userId)
      .select('asset_pet_identity.petAssetId')
      .executeTakeFirst();
    return !!row;
  }

  async assignIdentity(petAssetId: string, petId: string, ownerId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const sighting = await trx
        .selectFrom('asset_pet')
        .select(['assetId', 'trackId'])
        .where('id', '=', petAssetId)
        .executeTakeFirst();
      if (!sighting) {
        return;
      }
      const trackSightings = trx
        .selectFrom('asset_pet')
        .select('asset_pet.id')
        .where('asset_pet.assetId', '=', sighting.assetId)
        .where('asset_pet.trackId', '=', sighting.trackId);
      await trx
        .deleteFrom('asset_pet_identity')
        .where('petAssetId', 'in', trackSightings)
        .where('petId', 'in', trx.selectFrom('pet').select('pet.id').where('pet.ownerId', '=', ownerId))
        .execute();
      await trx
        .insertInto('asset_pet_identity')
        .columns(['petAssetId', 'petId'])
        .expression((eb) =>
          eb
            .selectFrom('asset_pet')
            .select(['asset_pet.id', eb.val(petId).as('petId')])
            .where('asset_pet.assetId', '=', sighting.assetId)
            .where('asset_pet.trackId', '=', sighting.trackId),
        )
        .onConflict((oc) => oc.columns(['petAssetId', 'petId']).doNothing())
        .execute();
      await trx
        .updateTable('pet')
        .set((eb) => ({ featurePetAssetId: eb.fn.coalesce('featurePetAssetId', eb.val(petAssetId)) }))
        .where('id', '=', petId)
        .execute();
    });
  }

  async assignTrackIdentity(
    assetId: string,
    trackId: string,
    petId: string,
    userId: string,
    assetOwnerId: string,
  ): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const trackSightings = trx
        .selectFrom('asset_pet')
        .select('asset_pet.id')
        .where('asset_pet.assetId', '=', assetId)
        .where('asset_pet.trackId', '=', trackId);
      const feature = await trackSightings.executeTakeFirst();
      if (!feature) {
        return;
      }

      if (userId === assetOwnerId) {
        await trx
          .updateTable('asset_pet')
          .set({ petId, isRejected: false })
          .where('assetId', '=', assetId)
          .where('trackId', '=', trackId)
          .execute();
      } else {
        const userPets = trx.selectFrom('pet').select('pet.id').where('pet.ownerId', '=', userId);
        await trx
          .deleteFrom('asset_pet_identity')
          .where('petAssetId', 'in', trackSightings)
          .where('petId', 'in', userPets)
          .execute();
        await trx
          .insertInto('asset_pet_identity')
          .columns(['petAssetId', 'petId'])
          .expression((eb) =>
            eb
              .selectFrom('asset_pet')
              .select(['asset_pet.id', eb.val(petId).as('petId')])
              .where('asset_pet.assetId', '=', assetId)
              .where('asset_pet.trackId', '=', trackId)
              .where('asset_pet.isRejected', '=', false),
          )
          .onConflict((oc) => oc.columns(['petAssetId', 'petId']).doNothing())
          .execute();
      }

      await trx
        .updateTable('pet')
        .set((eb) => ({ featurePetAssetId: eb.fn.coalesce('featurePetAssetId', eb.val(feature.id)) }))
        .where('id', '=', petId)
        .execute();
    });
  }

  async unassignTrackIdentity(assetId: string, trackId: string, userId: string, assetOwnerId: string): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      const userPets = trx.selectFrom('pet').select('pet.id').where('pet.ownerId', '=', userId);
      const trackSightings = trx
        .selectFrom('asset_pet')
        .select('asset_pet.id')
        .where('asset_pet.assetId', '=', assetId)
        .where('asset_pet.trackId', '=', trackId);

      if (userId === assetOwnerId) {
        await trx
          .updateTable('asset_pet')
          .set({ petId: null })
          .where('assetId', '=', assetId)
          .where('trackId', '=', trackId)
          .where('petId', 'in', userPets)
          .execute();
      }

      await trx
        .deleteFrom('asset_pet_identity')
        .where('petAssetId', 'in', trackSightings)
        .where('petId', 'in', userPets)
        .execute();
    });
  }

  setTracksRejected(assetId: string, trackIds: string[], isRejected: boolean): Promise<unknown> {
    return this.db
      .updateTable('asset_pet')
      .set({ isRejected })
      .where('assetId', '=', assetId)
      .where('trackId', 'in', trackIds)
      .execute();
  }

  async updateTrackSpecies(assetId: string, trackIds: string[], species: string): Promise<string[]> {
    return this.db.transaction().execute(async (trx) => {
      const trackSightings = trx
        .selectFrom('asset_pet')
        .select('asset_pet.id')
        .where('asset_pet.assetId', '=', assetId)
        .where('asset_pet.trackId', 'in', trackIds);
      const ownerAssignments = await trx
        .selectFrom('asset_pet')
        .select('asset_pet.petId')
        .where('asset_pet.assetId', '=', assetId)
        .where('asset_pet.trackId', 'in', trackIds)
        .where('asset_pet.petId', 'is not', null)
        .execute();
      const sharedAssignments = await trx
        .selectFrom('asset_pet_identity')
        .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
        .select('asset_pet_identity.petId')
        .where('asset_pet.assetId', '=', assetId)
        .where('asset_pet.trackId', 'in', trackIds)
        .execute();

      await trx.deleteFrom('asset_pet_identity').where('petAssetId', 'in', trackSightings).execute();
      await trx
        .updateTable('asset_pet')
        .set({ species, petId: null, isRejected: false })
        .where('assetId', '=', assetId)
        .where('trackId', 'in', trackIds)
        .execute();

      return [
        ...new Set(
          [...ownerAssignments, ...sharedAssignments]
            .map(({ petId }) => petId)
            .filter((petId): petId is string => petId !== null),
        ),
      ];
    });
  }

  async deleteSharedIdentitiesWithoutAccess(): Promise<string[]> {
    const removed = await this.db
      .deleteFrom('asset_pet_identity')
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('asset_pet')
              .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
              .innerJoin('pet', 'pet.id', 'asset_pet_identity.petId')
              .whereRef('asset_pet.id', '=', 'asset_pet_identity.petAssetId')
              .where((eb) =>
                eb.or([
                  eb.exists(
                    eb
                      .selectFrom('album_asset')
                      .innerJoin('album', (join) =>
                        join.onRef('album.id', '=', 'album_asset.albumId').on('album.deletedAt', 'is', null),
                      )
                      .innerJoin('album_user', 'album_user.albumId', 'album.id')
                      .whereRef('album_asset.assetId', '=', 'asset.id')
                      .whereRef('album_user.userId', '=', 'pet.ownerId')
                      .select('album_asset.assetId'),
                  ),
                  eb.exists(
                    eb
                      .selectFrom('partner')
                      .whereRef('partner.sharedById', '=', 'asset.ownerId')
                      .whereRef('partner.sharedWithId', '=', 'pet.ownerId')
                      .where('asset.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Hidden])
                      .select('partner.sharedById'),
                  ),
                ]),
              )
              .select('asset_pet.id'),
          ),
        ),
      )
      .returning('petId')
      .execute();
    return [...new Set(removed.map(({ petId }) => petId))];
  }

  async refreshFeature(petId: string): Promise<void> {
    const currentFeature = await this.db
      .selectFrom('pet')
      .innerJoin('asset_pet', 'asset_pet.id', 'pet.featurePetAssetId')
      .select('asset_pet.id')
      .where('pet.id', '=', petId)
      .where('asset_pet.isRejected', '=', false)
      .where((eb) =>
        eb.or([
          eb('asset_pet.petId', '=', petId),
          eb.exists(
            eb
              .selectFrom('asset_pet_identity')
              .select('asset_pet_identity.petAssetId')
              .whereRef('asset_pet_identity.petAssetId', '=', 'asset_pet.id')
              .where('asset_pet_identity.petId', '=', petId),
          ),
        ]),
      )
      .executeTakeFirst();

    // A stable representative is especially important after the pet is
    // named: it is both the visible thumbnail and the recognition anchor.
    if (currentFeature) {
      return;
    }

    await this.db
      .updateTable('pet')
      .set((eb) => ({
        featurePetAssetId: eb
          .selectFrom((inner) =>
            inner
              .selectFrom('asset_pet')
              .select(['asset_pet.id', 'asset_pet.petId'])
              .where('asset_pet.petId', 'is not', null)
              .where('asset_pet.isRejected', '=', false)
              .unionAll(
                inner
                  .selectFrom('asset_pet_identity')
                  .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
                  .select(['asset_pet_identity.petAssetId as id', 'asset_pet_identity.petId'])
                  .where('asset_pet.isRejected', '=', false),
              )
              .as('pet_sightings'),
          )
          .select('pet_sightings.id')
          .where('pet_sightings.petId', '=', petId)
          .limit(1),
      }))
      .where('pet.id', '=', petId)
      .execute();
  }

  async resetRecognition(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('asset_pet_identity').execute();
      await trx.updateTable('asset_pet').set({ petId: null }).execute();
      await trx.deleteFrom('pet').where('name', '=', '').execute();
    });
  }

  async deleteAllDetections(): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('asset_pet').where('isRejected', '=', false).execute();
      await trx.deleteFrom('pet').execute();
    });
  }

  async cleanupEmptyPets(): Promise<void> {
    await this.db
      .deleteFrom('pet')
      .where('name', '=', '')
      .where((eb) =>
        eb.and([
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_pet')
                .whereRef('asset_pet.petId', '=', 'pet.id')
                .where('asset_pet.isRejected', '=', false),
            ),
          ),
          eb.not(
            eb.exists(
              eb
                .selectFrom('asset_pet_identity')
                .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
                .whereRef('asset_pet_identity.petId', '=', 'pet.id')
                .where('asset_pet.isRejected', '=', false),
            ),
          ),
        ]),
      )
      .execute();
  }

  getAssetPets(assetId: string, ownerId: string) {
    return this.db
      .selectFrom('asset_pet')
      .selectAll('asset_pet')
      .select((eb) =>
        jsonObjectFrom(
          eb
            .selectFrom('pet')
            .selectAll('pet')
            .where('pet.ownerId', '=', ownerId)
            .where((eb) =>
              eb.or([
                eb('pet.id', '=', eb.ref('asset_pet.petId')),
                eb.exists(
                  eb
                    .selectFrom('asset_pet_identity')
                    .whereRef('asset_pet_identity.petAssetId', '=', 'asset_pet.id')
                    .whereRef('asset_pet_identity.petId', '=', 'pet.id'),
                ),
              ]),
            ),
        ).as('pet'),
      )
      .where('asset_pet.assetId', '=', assetId)
      .where('asset_pet.isRejected', '=', false)
      .orderBy('asset_pet.frameTimestampMs')
      .orderBy('asset_pet.boundingBoxX1')
      .execute();
  }

  getAllPets(ownerId: string, petId?: string) {
    return (
      this.db
        .selectFrom('pet')
        .selectAll('pet')
        .select((eb) =>
          eb
            .selectFrom((inner) =>
              inner
                .selectFrom('asset_pet')
                .select(['asset_pet.assetId', 'asset_pet.petId'])
                .where('asset_pet.petId', 'is not', null)
                .where('asset_pet.isRejected', '=', false)
                .unionAll(
                  inner
                    .selectFrom('asset_pet_identity')
                    .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
                    .select(['asset_pet.assetId', 'asset_pet_identity.petId'])
                    .where('asset_pet.isRejected', '=', false),
                )
                .as('pet_sightings'),
            )
            // A video may contain many timed sightings of the same pet. The
            // public "items" count, like People and asset search, represents
            // unique media assets rather than individual detection frames.
            .select((eb) => eb.fn.count<number>(eb.fn('distinct', ['pet_sightings.assetId'])).as('count'))
            .whereRef('pet_sightings.petId', '=', 'pet.id')
            .as('assetCount'),
        )
        .select((eb) =>
          jsonObjectFrom(
            eb
              .selectFrom('asset_pet')
              .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
              .select([
                'asset_pet.assetId',
                'asset.type',
                'asset_pet.frameTimestampMs',
                'asset_pet.imageWidth',
                'asset_pet.imageHeight',
                'asset_pet.boundingBoxX1',
                'asset_pet.boundingBoxY1',
                'asset_pet.boundingBoxX2',
                'asset_pet.boundingBoxY2',
              ])
              .whereRef('asset_pet.id', '=', 'pet.featurePetAssetId'),
          ).as('feature'),
        )
        .where('pet.ownerId', '=', ownerId)
        .$if(!!petId, (qb) => qb.where('pet.id', '=', petId!))
        .where((eb) =>
          eb.or([
            eb.exists(
              eb
                .selectFrom('asset_pet')
                .whereRef('asset_pet.petId', '=', 'pet.id')
                .where('asset_pet.isRejected', '=', false),
            ),
            eb.exists(
              eb
                .selectFrom('asset_pet_identity')
                .innerJoin('asset_pet', 'asset_pet.id', 'asset_pet_identity.petAssetId')
                .whereRef('asset_pet_identity.petId', '=', 'pet.id')
                .where('asset_pet.isRejected', '=', false),
            ),
          ]),
        )
        // Keep the list stable when a pet is named. Sorting by the mutable name
        // caused freshly labelled cards to jump to a different grid position.
        .orderBy('assetCount', 'desc')
        .orderBy('pet.createdAt')
        .orderBy('pet.id')
        .execute()
    );
  }

  getPetFeature(ownerId: string, id: string) {
    return this.db
      .selectFrom('pet')
      .innerJoin('asset_pet', 'asset_pet.id', 'pet.featurePetAssetId')
      .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
      .select(['asset.type', 'asset.originalPath', 'asset_pet.frameTimestampMs'])
      .where('pet.ownerId', '=', ownerId)
      .where('pet.id', '=', id)
      .where('asset_pet.isRejected', '=', false)
      .executeTakeFirst();
  }

  getSightingThumbnailSource(id: string) {
    return this.db
      .selectFrom('asset_pet')
      .innerJoin('asset', 'asset.id', 'asset_pet.assetId')
      .select(['asset_pet.assetId', 'asset_pet.frameTimestampMs', 'asset.type', 'asset.originalPath'])
      .where('asset_pet.id', '=', id)
      .executeTakeFirst();
  }

  getPet(ownerId: string, id: string) {
    return this.db.selectFrom('pet').selectAll().where('ownerId', '=', ownerId).where('id', '=', id).executeTakeFirst();
  }
}
