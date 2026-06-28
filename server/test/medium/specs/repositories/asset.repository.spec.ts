import { Kysely } from 'kysely';
import { mapAsset } from 'src/dtos/asset-response.dto';
import { AssetOrder, AssetVisibility } from 'src/enum';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetRepository.name, () => {
  // Fork: a shared asset's faces carry per-viewer person links (asset_face_person).
  describe('getById with shared faces (fork)', () => {
    it('surfaces the viewer own person on a shared face, and hides it from others', async () => {
      const { ctx, sut } = setup();
      const personRepo = ctx.get(PersonRepository);
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const { person: ownerPerson } = await ctx.newPerson({ ownerId: owner.id, name: 'Owner Alice' });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: ownerPerson.id });

      const { person: viewerPerson } = await ctx.newPerson({ ownerId: viewer.id, name: 'Viewer Alice' });
      await personRepo.linkFacePerson({ faceId: assetFace.id, personId: viewerPerson.id });

      const entity = await sut.getById(asset.id, { faces: { person: true } });
      expect(entity).toBeDefined();

      // The viewer sees their own person (plus the owner's existing tag).
      const forViewer = mapAsset(entity!, { auth: factory.auth({ user: { id: viewer.id } }) });
      const viewerPeopleIds = (forViewer.people ?? []).map((person) => person.id);
      expect(viewerPeopleIds).toContain(viewerPerson.id);
      expect(viewerPeopleIds).toContain(ownerPerson.id);

      // A different user does not see the viewer's private person.
      const forOwner = mapAsset(entity!, { auth: factory.auth({ user: { id: owner.id } }) });
      const ownerPeopleIds = (forOwner.people ?? []).map((person) => person.id);
      expect(ownerPeopleIds).toContain(ownerPerson.id);
      expect(ownerPeopleIds).not.toContain(viewerPerson.id);
    });
  });

  describe('getTimeBucket', () => {
    it('should order assets by local day first and fileCreatedAt within each day', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user: { id: user.id } });

      const [{ asset: previousLocalDayAsset }, { asset: nextLocalDayEarlierAsset }, { asset: nextLocalDayLaterAsset }] =
        await Promise.all([
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-09T00:30:00.000Z'),
            localDateTime: new Date('2026-03-08T22:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:30:00.000Z'),
            localDateTime: new Date('2026-03-09T01:30:00.000Z'),
          }),
          ctx.newAsset({
            ownerId: user.id,
            fileCreatedAt: new Date('2026-03-08T23:45:00.000Z'),
            localDateTime: new Date('2026-03-09T01:45:00.000Z'),
          }),
        ]);

      await Promise.all([
        ctx.newExif({ assetId: previousLocalDayAsset.id, timeZone: 'UTC-2' }),
        ctx.newExif({ assetId: nextLocalDayEarlierAsset.id, timeZone: 'UTC+2' }),
        ctx.newExif({ assetId: nextLocalDayLaterAsset.id, timeZone: 'UTC+2' }),
      ]);

      const descendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Desc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(descendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [nextLocalDayLaterAsset.id, nextLocalDayEarlierAsset.id, previousLocalDayAsset.id],
        }),
      );

      const ascendingBucket = await sut.getTimeBucket(
        '2026-03-01',
        { order: AssetOrder.Asc, userIds: [user.id], visibility: AssetVisibility.Timeline },
        auth,
      );
      expect(JSON.parse(ascendingBucket.assets)).toEqual(
        expect.objectContaining({
          id: [previousLocalDayAsset.id, nextLocalDayEarlierAsset.id, nextLocalDayLaterAsset.id],
        }),
      );
    });

    // Fork: a person's timeline includes photos of them shared via albums.
    it('includes shared-album assets containing the viewer person when sharedAlbumWithUserId is set', async () => {
      const { ctx, sut } = setup();
      const personRepo = ctx.get(PersonRepository);
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const auth = factory.auth({ user: { id: viewer.id } });

      const { asset } = await ctx.newAsset({
        ownerId: owner.id,
        fileCreatedAt: new Date('2026-03-08T23:30:00.000Z'),
        localDateTime: new Date('2026-03-08T23:30:00.000Z'),
      });
      await ctx.newExif({ assetId: asset.id, timeZone: 'UTC' });
      const { person: ownerPerson } = await ctx.newPerson({ ownerId: owner.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: ownerPerson.id });

      const { person: viewerPerson } = await ctx.newPerson({ ownerId: viewer.id });
      await personRepo.linkFacePerson({ faceId: assetFace.id, personId: viewerPerson.id });

      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id });

      const options = {
        personId: viewerPerson.id,
        userIds: [viewer.id],
        visibility: AssetVisibility.Timeline,
      };

      const withShared = await sut.getTimeBucket('2026-03-01', { ...options, sharedAlbumWithUserId: viewer.id }, auth);
      expect(JSON.parse(withShared.assets).id ?? []).toContain(asset.id);

      // Control: without the shared-album option, the shared asset is excluded.
      const withoutShared = await sut.getTimeBucket('2026-03-01', options, auth);
      expect(JSON.parse(withoutShared.assets).id ?? []).not.toContain(asset.id);
    });
  });

  describe('upsertExif', () => {
    it('should append to locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal'] });

      await sut.upsertExif(
        { assetId: asset.id, lockedProperties: ['description'] },
        { lockedPropertiesBehavior: 'append' },
      );

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });

    it('should deduplicate locked columns', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.upsertExif(
        { assetId: asset.id, lockedProperties: ['description'] },
        { lockedPropertiesBehavior: 'append' },
      );

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description', 'dateTimeOriginal'] });
    });
  });

  describe('unlockProperties', () => {
    it('should unlock one property', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['description'] });
    });

    it('should unlock all properties', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({
        assetId: asset.id,
        dateTimeOriginal: '2023-11-19T18:11:00',
        lockedProperties: ['dateTimeOriginal', 'description'],
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: ['dateTimeOriginal', 'description'] });

      await sut.unlockProperties(asset.id, ['description', 'dateTimeOriginal']);

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });
    });
  });
});
