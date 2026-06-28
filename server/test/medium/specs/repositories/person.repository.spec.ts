import { Kysely } from 'kysely';
import { AssetFileType } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PersonRepository } from 'src/repositories/person.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(PersonRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// Fork: an owner asset whose face is recognized for both the owner and a viewer
// (via the asset_face_person join table).
const setupSharedFace = async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const { user: viewer } = await ctx.newUser();

  const { asset } = await ctx.newAsset({ ownerId: owner.id });
  const { person: ownerPerson } = await ctx.newPerson({ ownerId: owner.id, name: 'Owner Alice' });
  const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personId: ownerPerson.id });

  const { person: viewerPerson } = await ctx.newPerson({ ownerId: viewer.id, name: 'Viewer Alice' });
  await sut.linkFacePerson({ faceId: assetFace.id, personId: viewerPerson.id });

  return { ctx, sut, owner, viewer, asset, ownerPerson, viewerPerson, assetFace };
};

describe(PersonRepository.name, () => {
  describe('getDataForThumbnailGenerationJob', () => {
    it('should not return the edited preview path', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });

      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personId: person.id,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });

      // theres a circular dependency between assetFace and person, so we need to update the person after creating the assetFace
      await ctx.database.updateTable('person').set({ faceAssetId: assetFace.id }).where('id', '=', person.id).execute();

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getDataForThumbnailGenerationJob(person.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewPath: 'preview_unedited.jpg',
        }),
      );
    });
  });

  // Fork: per-viewer face assignments via the asset_face_person join table.
  describe('shared per-viewer faces (fork)', () => {
    it('getStatistics counts assets linked via the join table', async () => {
      const { sut, viewerPerson, ownerPerson } = await setupSharedFace();
      await expect(sut.getStatistics(viewerPerson.id)).resolves.toEqual({ assets: 1 });
      // owner path is unchanged
      await expect(sut.getStatistics(ownerPerson.id)).resolves.toEqual({ assets: 1 });
    });

    it('hasFacePersonForUser reflects the link', async () => {
      const { sut, viewer, owner, assetFace } = await setupSharedFace();
      await expect(sut.hasFacePersonForUser(assetFace.id, viewer.id)).resolves.toBe(true);
      await expect(sut.hasFacePersonForUser(assetFace.id, owner.id)).resolves.toBe(false);
    });

    it('getAllForUser includes a person whose faces are only shared', async () => {
      const { sut, viewer, viewerPerson } = await setupSharedFace();
      const { items } = await sut.getAllForUser({ take: 100, skip: 0 }, viewer.id, {
        minimumFaceCount: 1,
        withHidden: true,
      });
      expect(items.map((p) => p.id)).toContain(viewerPerson.id);
    });

    it('getNumberOfPeople counts a shared-only person', async () => {
      const { sut, viewer } = await setupSharedFace();
      await expect(sut.getNumberOfPeople(viewer.id)).resolves.toEqual(
        expect.objectContaining({ total: 1 }),
      );
    });

    it('getAllWithoutFaces does NOT flag a shared-only person (cleanup safety)', async () => {
      const { sut, viewerPerson } = await setupSharedFace();
      const faceless = await sut.getAllWithoutFaces();
      expect(faceless.map((p) => p.id)).not.toContain(viewerPerson.id);
    });

    it('getRandomFace finds a face linked via the join table', async () => {
      const { sut, viewerPerson, assetFace } = await setupSharedFace();
      const face = await sut.getRandomFace(viewerPerson.id);
      expect(face?.id).toBe(assetFace.id);
    });

    it('getAdditionalAccessUserIds returns album members and partners (not the owner)', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: albumMember } = await ctx.newUser();
      const { user: partner } = await ctx.newUser();
      const { user: stranger } = await ctx.newUser();

      const { asset } = await ctx.newAsset({ ownerId: owner.id });
      const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
      await ctx.newAlbumUser({ albumId: album.id, userId: albumMember.id });
      await ctx.newPartner({ sharedById: owner.id, sharedWithId: partner.id });

      const userIds = await sut.getAdditionalAccessUserIds(asset.id, owner.id);
      expect(userIds).toEqual(expect.arrayContaining([albumMember.id, partner.id]));
      expect(userIds).not.toContain(owner.id);
      expect(userIds).not.toContain(stranger.id);
    });
  });
});
