import { AssetType, AssetVisibility, JobName, JobStatus } from 'src/enum';
import { PetService } from 'src/services/pet.service';
import { makeStream, newTestService, ServiceMocks } from 'test/utils';

const petConfig = {
  enabled: true,
  detectionModelName: 'yolox_s',
  recognitionModelName: 'AnimalID-CLIP-ViT-B-32',
  minScore: 0.65,
  maxDistance: 0.2,
  minPets: 3,
};

const sighting = {
  id: '10000000-0000-4000-8000-000000000001',
  assetId: '20000000-0000-4000-8000-000000000001',
  petId: null,
  imageWidth: 1000,
  imageHeight: 800,
  boundingBoxX1: 10,
  boundingBoxY1: 20,
  boundingBoxX2: 200,
  boundingBoxY2: 300,
  detectionScore: 0.95,
  species: 'dog',
  trackId: '10000000-0000-4000-8000-000000000001',
  isRejected: false,
  frameTimestampMs: 0,
  frameDurationMs: null,
  updatedAt: new Date(),
  updateId: '30000000-0000-4000-8000-000000000001',
  asset: {
    ownerId: '40000000-0000-4000-8000-000000000001',
    fileCreatedAt: new Date().toISOString(),
    visibility: AssetVisibility.Timeline,
  },
  petSearch: {
    petAssetId: '10000000-0000-4000-8000-000000000001',
    embedding: '[0.1,0.2]',
  },
};

describe(PetService.name, () => {
  let sut: PetService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PetService));
    mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { petRecognition: petConfig } });
    mocks.person.getAdditionalAccessUserIds.mockResolvedValue([]);
    mocks.pet.getSightingsForSharedRecognition.mockReturnValue(makeStream([]));
    mocks.pet.deleteSharedIdentitiesWithoutAccess.mockResolvedValue([]);
  });

  it('gets a single pet owned by the current user', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const petId = '60000000-0000-4000-8000-000000000001';
    mocks.pet.getAllPets.mockResolvedValue([
      {
        id: petId,
        ownerId,
        name: 'Miki',
        species: 'dog',
        isHidden: false,
        featurePetAssetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        updateId: '70000000-0000-4000-8000-000000000001',
        assetCount: 3,
        feature: null,
      },
    ]);

    await expect(sut.getById({ user: { id: ownerId } } as never, petId)).resolves.toEqual(
      expect.objectContaining({
        id: petId,
        name: 'Miki',
        species: 'dog',
        isHidden: false,
        featurePetAssetId: null,
        assetCount: 3,
      }),
    );
    expect(mocks.pet.getAllPets).toHaveBeenCalledWith(ownerId, petId);
  });

  it('uses multi-example similarity for manual track suggestions', async () => {
    const ownerId = sighting.asset.ownerId;
    const currentPetId = '60000000-0000-4000-8000-000000000001';
    const mikiId = '60000000-0000-4000-8000-000000000002';
    const currentPet = {
      id: currentPetId,
      ownerId,
      name: '',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const miki = {
      ...currentPet,
      id: mikiId,
      name: 'Miki',
      featurePetAssetId: '10000000-0000-4000-8000-000000000002',
      updateId: '70000000-0000-4000-8000-000000000002',
    };
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({ pets: [sighting] } as never);
    mocks.pet.getTrackEmbedding.mockResolvedValue('[0.1,0.2]');
    mocks.pet.searchSuggestionCandidates.mockResolvedValue([
      { petId: currentPetId, distance: 0.01 },
      { petId: mikiId, distance: 0.12 },
    ]);
    mocks.pet.getAssetPets.mockResolvedValue([{ ...sighting, petId: currentPetId, pet: currentPet }] as never);
    mocks.pet.getAllPets.mockResolvedValue([currentPet, miki].map((pet) => ({ ...pet, assetCount: 1, feature: null })));

    await expect(
      sut.getTrackSuggestions({ user: { id: ownerId } } as never, sighting.assetId, sighting.trackId),
    ).resolves.toEqual([{ pet: expect.objectContaining({ id: mikiId, name: 'Miki' }), distance: 0.12 }]);
    expect(mocks.pet.searchSuggestionCandidates).toHaveBeenCalledWith(ownerId, 'dog', '[0.1,0.2]', 0.2, 8);
    expect(mocks.pet.searchCentroidCandidates).not.toHaveBeenCalled();
  });

  it('projects pet centroids and reports the nearest same-species identity', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const firstId = '60000000-0000-4000-8000-000000000001';
    const secondId = '60000000-0000-4000-8000-000000000002';
    mocks.pet.getAllPets.mockResolvedValue(
      [firstId, secondId].map((id, index) => ({
        id,
        ownerId,
        name: index === 0 ? 'Miki' : 'Demon',
        species: 'dog',
        isHidden: false,
        featurePetAssetId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        updateId: `70000000-0000-4000-8000-00000000000${index + 1}`,
        assetCount: 2,
        feature: null,
      })),
    );
    mocks.pet.getClusterCentroids.mockResolvedValue([
      { petId: firstId, embedding: '[1,0,0]' },
      { petId: secondId, embedding: '[0.8,0.6,0]' },
    ]);

    const result = await sut.getClusters({ user: { id: ownerId } } as never);

    expect(result.recognitionThreshold).toBe(petConfig.maxDistance);
    expect(result.points).toHaveLength(2);
    expect(result.points[0]).toEqual(
      expect.objectContaining({ id: firstId, nearestPetId: secondId, nearestDistance: expect.any(Number) }),
    );
    expect(result.points.every(({ x, y }) => Number.isFinite(x) && Number.isFinite(y))).toBe(true);
  });

  it('rejects a pet that is not owned by the current user', async () => {
    mocks.pet.getAllPets.mockResolvedValue([]);

    await expect(
      sut.getById(
        { user: { id: '40000000-0000-4000-8000-000000000001' } } as never,
        '60000000-0000-4000-8000-000000000001',
      ),
    ).rejects.toThrow('Pet not found');
  });

  it('extracts a pet sighting thumbnail from its analyzed video timestamp', async () => {
    const frame = Buffer.from('video-frame');
    mocks.pet.getSightingThumbnailSource.mockResolvedValue({
      assetId: sighting.assetId,
      type: AssetType.Video,
      originalPath: '/videos/dogs.mp4',
      frameTimestampMs: 20_000,
    });
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.media.extractVideoFrame.mockResolvedValue(frame);

    await expect(
      sut.getSightingThumbnail({ user: { id: sighting.asset.ownerId } } as never, sighting.id),
    ).resolves.toEqual(frame);
    expect(mocks.media.extractVideoFrame).toHaveBeenCalledWith('/videos/dogs.mp4', 20_000);
  });

  it('removes only the current users identity from a pet sighting', async () => {
    const ownerId = sighting.asset.ownerId;
    const petId = '60000000-0000-4000-8000-000000000001';
    const pet = {
      id: petId,
      ownerId,
      name: 'Miki',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    mocks.pet.getSightingForRecognition.mockResolvedValue(sighting);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetPets.mockResolvedValue([{ ...sighting, petId, pet }] as never);

    await sut.unassignAssetPet({ user: { id: ownerId } } as never, sighting.id);

    expect(mocks.pet.unassignIdentity).toHaveBeenCalledWith(sighting.id, petId, ownerId);
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(petId);
    expect(mocks.pet.cleanupEmptyPets).toHaveBeenCalled();
  });

  it('assigns only the selected video track to an existing pet', async () => {
    const ownerId = sighting.asset.ownerId;
    const targetPet = {
      id: '60000000-0000-4000-8000-000000000001',
      ownerId,
      name: 'Miki',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const assigned = { ...sighting, petId: targetPet.id, pet: targetPet };
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: sighting.assetId,
      ownerId,
      pets: [sighting],
      files: [],
    } as never);
    mocks.pet.getPet.mockResolvedValue(targetPet);
    mocks.pet.getAssetPets.mockResolvedValueOnce([sighting] as never).mockResolvedValueOnce([assigned] as never);

    await expect(
      sut.assignTracks({ user: { id: ownerId } } as never, {
        selectors: [{ assetId: sighting.assetId, trackId: sighting.trackId }],
        target: { type: 'existing', petId: targetPet.id },
      }),
    ).resolves.toEqual([assigned]);

    expect(mocks.pet.assignTrackIdentity).toHaveBeenCalledWith(
      sighting.assetId,
      sighting.trackId,
      targetPet.id,
      ownerId,
      ownerId,
    );
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(targetPet.id);
  });

  it('rejects exactly the selected track and keeps the action reversible', async () => {
    const ownerId = sighting.asset.ownerId;
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: sighting.assetId,
      ownerId,
      pets: [sighting],
      files: [],
    } as never);
    mocks.pet.getAssetPets.mockResolvedValue([]);

    await expect(
      sut.assignTracks({ user: { id: ownerId } } as never, {
        selectors: [{ assetId: sighting.assetId, trackId: sighting.trackId }],
        target: { type: 'rejected' },
      }),
    ).resolves.toEqual([]);

    expect(mocks.pet.setTracksRejected).toHaveBeenCalledWith(sighting.assetId, [sighting.trackId], true);
  });

  it('corrects a detected track species and clears incompatible identities', async () => {
    const ownerId = sighting.asset.ownerId;
    const affectedPetId = '60000000-0000-4000-8000-000000000001';
    const corrected = { ...sighting, species: 'cat' };
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: sighting.assetId,
      ownerId,
      pets: [sighting],
      files: [],
    } as never);
    mocks.pet.getAssetPets.mockResolvedValueOnce([sighting] as never).mockResolvedValueOnce([corrected] as never);
    mocks.pet.updateTrackSpecies.mockResolvedValue([affectedPetId]);

    await expect(
      sut.assignTracks({ user: { id: ownerId } } as never, {
        selectors: [{ assetId: sighting.assetId, trackId: sighting.trackId }],
        target: { type: 'species', species: 'cat' },
      }),
    ).resolves.toEqual([corrected]);

    expect(mocks.pet.updateTrackSpecies).toHaveBeenCalledWith(sighting.assetId, [sighting.trackId], 'cat');
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(affectedPetId);
    expect(mocks.pet.cleanupEmptyPets).toHaveBeenCalled();
  });

  it('does not allow a shared-library viewer to reject the asset owners track', async () => {
    const viewerId = '40000000-0000-4000-8000-000000000099';
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: sighting.assetId,
      ownerId: sighting.asset.ownerId,
      pets: [sighting],
      files: [],
    } as never);

    await expect(
      sut.assignTracks({ user: { id: viewerId } } as never, {
        selectors: [{ assetId: sighting.assetId, trackId: sighting.trackId }],
        target: { type: 'rejected' },
      }),
    ).rejects.toThrow('Only the asset owner can reject pet tracks');
  });

  it('creates a manually selected pet sighting with an ML embedding', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const petId = '60000000-0000-4000-8000-000000000001';
    const sightingId = '10000000-0000-4000-8000-000000000002';
    const assetId = sighting.assetId;
    const pet = {
      id: petId,
      ownerId,
      name: 'Miki',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const created = {
      ...sighting,
      id: sightingId,
      assetId,
      petId,
      pet,
    };
    const region = { imageWidth: 1000, imageHeight: 800, x: 10, y: 20, width: 190, height: 280 };
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      files: [{ path: '/preview/image.jpg' }],
      pets: [],
    } as never);
    mocks.pet.getPet.mockResolvedValue(pet);
    mocks.machineLearning.recognizePetRegion.mockResolvedValue({
      imageWidth: 1000,
      imageHeight: 800,
      pet: {
        boundingBox: { x1: 10, y1: 20, x2: 200, y2: 300 },
        embedding: '[0.1,0.2]',
        score: 1,
        species: 'dog',
      },
    });
    mocks.crypto.randomUUID.mockReturnValue(sightingId);
    mocks.pet.getAssetPets.mockResolvedValue([created] as never);

    await expect(
      sut.createAssetPet({ user: { id: ownerId } } as never, { assetId, petId, species: 'dog', ...region }),
    ).resolves.toMatchObject({ id: sightingId, pet: { id: petId, name: 'Miki' } });

    expect(mocks.machineLearning.recognizePetRegion).toHaveBeenCalledWith(
      '/preview/image.jpg',
      petConfig,
      expect.objectContaining({ ...region, species: 'dog' }),
    );
    expect(mocks.pet.createSighting).toHaveBeenCalledWith(
      expect.objectContaining({ id: sightingId, assetId, petId, species: 'dog' }),
      { petAssetId: sightingId, embedding: '[0.1,0.2]' },
    );
  });

  it('embeds a manual video annotation from its playback timestamp', async () => {
    const assetId = '20000000-0000-4000-8000-000000000010';
    const ownerId = '40000000-0000-4000-8000-000000000010';
    const petId = '60000000-0000-4000-8000-000000000010';
    const sightingId = '10000000-0000-4000-8000-000000000010';
    const frame = Buffer.from('video-frame');
    const region = { imageWidth: 1080, imageHeight: 1920, x: 100, y: 200, width: 300, height: 400 };
    const pet = { id: petId, ownerId, name: 'Miki', species: 'dog' };
    const created = {
      ...sighting,
      id: sightingId,
      assetId,
      petId,
      frameTimestampMs: 12_345,
      frameDurationMs: 1000,
      pet,
    };

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId,
      type: AssetType.Video,
      originalPath: '/original/video.mov',
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      files: [{ path: '/preview/video.jpg' }],
      pets: [],
    } as never);
    mocks.pet.getPet.mockResolvedValue(pet as never);
    mocks.media.extractVideoFrame.mockResolvedValue(frame);
    mocks.machineLearning.recognizePetRegion.mockResolvedValue({
      imageWidth: 1080,
      imageHeight: 1920,
      pet: {
        boundingBox: { x1: 100, y1: 200, x2: 400, y2: 600 },
        embedding: '[0.1,0.2]',
        score: 1,
        species: 'dog',
      },
    });
    mocks.crypto.randomUUID.mockReturnValue(sightingId);
    mocks.pet.getAssetPets.mockResolvedValue([created] as never);

    await sut.createAssetPet({ user: { id: ownerId } } as never, {
      assetId,
      petId,
      species: 'dog',
      frameTimestampMs: 12_345,
      frameDurationMs: 1000,
      ...region,
    });

    expect(mocks.media.extractVideoFrame).toHaveBeenCalledWith('/original/video.mov', 12_345);
    expect(mocks.machineLearning.recognizePetRegion).toHaveBeenCalledWith(
      frame,
      petConfig,
      expect.objectContaining({ ...region, species: 'dog', frameTimestampMs: 12_345 }),
    );
    expect(mocks.pet.createSighting).toHaveBeenCalledWith(
      expect.objectContaining({ frameTimestampMs: 12_345, frameDurationMs: 1000 }),
      { petAssetId: sightingId, embedding: '[0.1,0.2]' },
    );
  });

  it('queues a label-preserving recluster from existing pet embeddings', async () => {
    await sut.runRecognition({} as never, { force: false, recluster: true });

    expect(mocks.job.queue).toHaveBeenCalledWith({
      name: JobName.PetRecognitionQueueAll,
      data: { force: true },
    });
  });

  it('detects pets in timed video frames and stores each frame segment', async () => {
    const assetId = sighting.assetId;
    const trackId = '10000000-0000-4000-8000-000000000010';
    const firstSightingId = '10000000-0000-4000-8000-000000000011';
    const lastSightingId = '10000000-0000-4000-8000-000000000012';
    const firstFrame = Buffer.from('first');
    const middleFrame = Buffer.from('middle');
    const lastFrame = Buffer.from('last');
    const detectedPet = {
      boundingBox: { x1: 10, y1: 20, x2: 200, y2: 300 },
      embedding: '[0.1,0.2]',
      score: 0.95,
      species: 'dog',
    };

    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId: sighting.asset.ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      type: AssetType.Video,
      originalPath: '/videos/dogs.mp4',
      duration: 12_000,
      files: [{ path: '/preview/dogs.jpg' }],
      pets: [],
    } as never);
    mocks.media.extractVideoFrame
      .mockResolvedValueOnce(firstFrame)
      .mockResolvedValueOnce(middleFrame)
      .mockResolvedValueOnce(lastFrame);
    mocks.machineLearning.detectPets
      .mockResolvedValueOnce({ imageWidth: 1000, imageHeight: 800, pets: [detectedPet] })
      .mockResolvedValueOnce({ imageWidth: 1000, imageHeight: 800, pets: [] })
      .mockResolvedValueOnce({ imageWidth: 1000, imageHeight: 800, pets: [detectedPet] });
    mocks.crypto.randomUUID
      .mockReturnValueOnce(trackId)
      .mockReturnValueOnce(firstSightingId)
      .mockReturnValueOnce(lastSightingId);

    await expect(sut.handleDetectPets({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.media.extractVideoFrame).toHaveBeenNthCalledWith(1, '/videos/dogs.mp4', 0);
    expect(mocks.media.extractVideoFrame).toHaveBeenNthCalledWith(2, '/videos/dogs.mp4', 5000);
    expect(mocks.media.extractVideoFrame).toHaveBeenNthCalledWith(3, '/videos/dogs.mp4', 10_000);
    expect(mocks.machineLearning.detectPets).toHaveBeenNthCalledWith(1, firstFrame, petConfig);
    expect(mocks.machineLearning.detectPets).toHaveBeenNthCalledWith(2, middleFrame, petConfig);
    expect(mocks.machineLearning.detectPets).toHaveBeenNthCalledWith(3, lastFrame, petConfig);
    expect(mocks.pet.replaceAssetPets).toHaveBeenCalledWith(
      assetId,
      [
        expect.objectContaining({
          id: firstSightingId,
          trackId,
          frameTimestampMs: 0,
          frameDurationMs: 5000,
        }),
        expect.objectContaining({
          id: lastSightingId,
          trackId,
          frameTimestampMs: 10_000,
          frameDurationMs: 2000,
        }),
      ],
      [
        { petAssetId: firstSightingId, embedding: detectedPet.embedding },
        { petAssetId: lastSightingId, embedding: detectedPet.embedding },
      ],
      { discardRejected: false },
    );
    expect(mocks.websocket.clientSend).toHaveBeenCalledWith('on_pet_update', sighting.asset.ownerId, {
      assetId,
      pets: 2,
    });
    expect(mocks.job.queueAll).toHaveBeenCalledWith([
      { name: JobName.PetRecognitionQueueAll, data: { force: false } },
      { name: JobName.PetRecognition, data: { id: firstSightingId, deferred: false } },
    ]);
  });

  it('does not recreate a rejected detection when pet detection is rerun', async () => {
    const assetId = sighting.assetId;
    const rejected = {
      ...sighting,
      isRejected: true,
      frameTimestampMs: 0,
      species: 'dog',
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 200,
      boundingBoxY2: 300,
    };
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId: sighting.asset.ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      type: AssetType.Image,
      originalPath: '/photos/dog.jpg',
      duration: null,
      files: [{ path: '/preview/dog.jpg' }],
      pets: [rejected],
    } as never);
    mocks.machineLearning.detectPets.mockResolvedValue({
      imageWidth: 1000,
      imageHeight: 800,
      pets: [
        {
          boundingBox: { x1: 12, y1: 22, x2: 198, y2: 298 },
          embedding: '[0.1,0.2]',
          score: 0.95,
          species: 'dog',
        },
      ],
    });

    await expect(sut.handleDetectPets({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.pet.replaceAssetPets).toHaveBeenCalledWith(assetId, [], [], { discardRejected: false });
    expect(mocks.crypto.randomUUID).not.toHaveBeenCalled();
  });

  it('discards rejected detections and recreates them during a forced pet refresh', async () => {
    const assetId = sighting.assetId;
    const trackId = '10000000-0000-4000-8000-000000000022';
    const petAssetId = '10000000-0000-4000-8000-000000000023';
    const detectedPet = {
      boundingBox: { x1: 12, y1: 22, x2: 198, y2: 298 },
      embedding: '[0.1,0.2]',
      score: 0.95,
      species: 'dog',
    };
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId: sighting.asset.ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      type: AssetType.Image,
      originalPath: '/photos/dog.jpg',
      duration: null,
      files: [{ path: '/preview/dog.jpg' }],
      pets: [
        {
          ...sighting,
          isRejected: true,
          frameTimestampMs: 0,
          species: 'dog',
          boundingBoxX1: 10,
          boundingBoxY1: 20,
          boundingBoxX2: 200,
          boundingBoxY2: 300,
        },
      ],
    } as never);
    mocks.machineLearning.detectPets.mockResolvedValue({
      imageWidth: 1000,
      imageHeight: 800,
      pets: [detectedPet],
    });
    mocks.crypto.randomUUID.mockReturnValueOnce(trackId).mockReturnValueOnce(petAssetId);

    await expect(sut.handleDetectPets({ id: assetId, force: true })).resolves.toBe(JobStatus.Success);

    expect(mocks.pet.replaceAssetPets).toHaveBeenCalledWith(
      assetId,
      [expect.objectContaining({ id: petAssetId, trackId, species: 'dog' })],
      [{ petAssetId, embedding: detectedPet.embedding }],
      { discardRejected: true },
    );
  });

  it('retries a forced pet refresh at the fallback score and continues through recognition', async () => {
    const assetId = sighting.assetId;
    const trackId = '10000000-0000-4000-8000-000000000020';
    const petAssetId = '10000000-0000-4000-8000-000000000021';
    const detectedPet = {
      boundingBox: { x1: 127, y1: 1046, x2: 821, y2: 1355 },
      embedding: '[0.3,0.4]',
      score: 0.356_776_893,
      species: 'dog',
    };
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId: sighting.asset.ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      type: AssetType.Image,
      originalPath: '/photos/dog.jpg',
      duration: null,
      files: [{ path: '/preview/dog.jpg' }],
      pets: [],
    } as never);
    mocks.machineLearning.detectPets
      .mockResolvedValueOnce({ imageWidth: 1440, imageHeight: 1920, pets: [] })
      .mockResolvedValueOnce({ imageWidth: 1440, imageHeight: 1920, pets: [detectedPet] });
    mocks.crypto.randomUUID.mockReturnValueOnce(trackId).mockReturnValueOnce(petAssetId);

    await expect(sut.handleDetectPets({ id: assetId, force: true })).resolves.toBe(JobStatus.Success);

    expect(mocks.machineLearning.detectPets).toHaveBeenNthCalledWith(1, '/preview/dog.jpg', petConfig);
    expect(mocks.machineLearning.detectPets).toHaveBeenNthCalledWith(2, '/preview/dog.jpg', {
      ...petConfig,
      minScore: 0.35,
    });
    expect(mocks.pet.replaceAssetPets).toHaveBeenCalledWith(
      assetId,
      [expect.objectContaining({ id: petAssetId, trackId, species: 'dog' })],
      [{ petAssetId, embedding: detectedPet.embedding }],
      { discardRejected: true },
    );
    expect(mocks.job.queueAll).toHaveBeenCalledWith([
      { name: JobName.PetRecognitionQueueAll, data: { force: false } },
      { name: JobName.PetRecognition, data: { id: petAssetId, deferred: false } },
    ]);
  });

  it('does not use the fallback score during automatic pet detection', async () => {
    const assetId = sighting.assetId;
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: assetId,
      ownerId: sighting.asset.ownerId,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: new Date(),
      type: AssetType.Image,
      originalPath: '/photos/dog.jpg',
      duration: null,
      files: [{ path: '/preview/dog.jpg' }],
      pets: [],
    } as never);
    mocks.machineLearning.detectPets.mockResolvedValue({ imageWidth: 1440, imageHeight: 1920, pets: [] });

    await expect(sut.handleDetectPets({ id: assetId })).resolves.toBe(JobStatus.Success);

    expect(mocks.machineLearning.detectPets).toHaveBeenCalledTimes(1);
    expect(mocks.machineLearning.detectPets).toHaveBeenCalledWith('/preview/dog.jpg', petConfig);
    expect(mocks.pet.replaceAssetPets).toHaveBeenCalledWith(assetId, [], [], { discardRejected: false });
  });

  it('merges a duplicate pet identity into the selected pet', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const targetId = '60000000-0000-4000-8000-000000000001';
    const sourceId = '60000000-0000-4000-8000-000000000002';
    const target = {
      id: targetId,
      ownerId,
      name: 'Miki',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const source = {
      ...target,
      id: sourceId,
      name: '',
      updateId: '70000000-0000-4000-8000-000000000002',
    };
    mocks.pet.getPet.mockResolvedValueOnce(target).mockResolvedValueOnce(source);
    mocks.pet.getAllPets.mockResolvedValue([
      {
        ...target,
        assetCount: 8,
        feature: {
          assetId: sighting.assetId,
          type: AssetType.Image,
          frameTimestampMs: 0,
          imageWidth: sighting.imageWidth,
          imageHeight: sighting.imageHeight,
          boundingBoxX1: sighting.boundingBoxX1,
          boundingBoxY1: sighting.boundingBoxY1,
          boundingBoxX2: sighting.boundingBoxX2,
          boundingBoxY2: sighting.boundingBoxY2,
        },
      },
    ]);

    await expect(sut.merge({ user: { id: ownerId } } as never, targetId, { ids: [sourceId] })).resolves.toMatchObject({
      id: targetId,
      name: 'Miki',
      assetCount: 8,
    });
    expect(mocks.pet.merge).toHaveBeenCalledWith(targetId, [sourceId]);
  });

  it('moves selected sightings to an existing pet identity', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const sourceId = '60000000-0000-4000-8000-000000000001';
    const targetId = '60000000-0000-4000-8000-000000000002';
    const assetIds = [sighting.assetId];
    const source = {
      id: sourceId,
      ownerId,
      name: 'Mixed dogs',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const target = {
      ...source,
      id: targetId,
      name: 'Miki',
      updateId: '70000000-0000-4000-8000-000000000002',
    };
    mocks.pet.getPet.mockResolvedValueOnce(source).mockResolvedValueOnce(target);
    mocks.pet.hasSightings.mockResolvedValue(true);
    mocks.pet.getAllPets.mockResolvedValue([{ ...target, assetCount: 4, feature: null }]);

    await expect(
      sut.reassign({ user: { id: ownerId } } as never, sourceId, { assetIds, targetPetId: targetId }),
    ).resolves.toMatchObject({ id: targetId, name: 'Miki', assetCount: 4 });

    expect(mocks.pet.reassignSightings).toHaveBeenCalledWith(sourceId, targetId, assetIds);
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(sourceId);
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(targetId);
    expect(mocks.pet.cleanupEmptyPets).toHaveBeenCalled();
  });

  it('creates a new pet identity for selected sightings', async () => {
    const ownerId = '40000000-0000-4000-8000-000000000001';
    const sourceId = '60000000-0000-4000-8000-000000000001';
    const targetId = '60000000-0000-4000-8000-000000000003';
    const source = {
      id: sourceId,
      ownerId,
      name: '',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    const target = {
      ...source,
      id: targetId,
      featurePetAssetId: null,
      updateId: '70000000-0000-4000-8000-000000000003',
    };
    mocks.pet.getPet.mockResolvedValue(source);
    mocks.pet.hasSightings.mockResolvedValue(true);
    mocks.pet.create.mockResolvedValue(target);
    mocks.pet.getAllPets.mockResolvedValue([{ ...target, assetCount: 2, feature: null }]);

    await expect(
      sut.reassign({ user: { id: ownerId } } as never, sourceId, { assetIds: [sighting.assetId] }),
    ).resolves.toMatchObject({ id: targetId, assetCount: 2 });

    expect(mocks.pet.create).toHaveBeenCalledWith({ ownerId, species: 'dog' });
    expect(mocks.pet.reassignSightings).toHaveBeenCalledWith(sourceId, targetId, [sighting.assetId]);
  });

  it('rejects only appearances of the selected pet in the selected assets', async () => {
    const ownerId = sighting.asset.ownerId;
    const petId = '60000000-0000-4000-8000-000000000001';
    const otherPetId = '60000000-0000-4000-8000-000000000002';
    const secondTrackId = '10000000-0000-4000-8000-000000000002';
    const source = {
      id: petId,
      ownerId,
      name: '',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    };
    mocks.pet.getPet.mockResolvedValue(source);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([sighting.assetId]));
    mocks.pet.getAssetForDetection.mockResolvedValue({
      id: sighting.assetId,
      ownerId,
      pets: [sighting, { ...sighting, id: secondTrackId, trackId: secondTrackId }],
      files: [],
    } as never);
    mocks.pet.getAssetPets.mockResolvedValue([
      { ...sighting, pet: source },
      { ...sighting, id: secondTrackId, trackId: secondTrackId, pet: { ...source, id: otherPetId } },
    ] as never);

    await expect(
      sut.rejectAppearances({ user: { id: ownerId } } as never, petId, {
        assetIds: [sighting.assetId, sighting.assetId],
      }),
    ).resolves.toEqual({ rejected: 1 });

    expect(mocks.pet.getAssetForDetection).toHaveBeenCalledTimes(1);
    expect(mocks.pet.setTracksRejected).toHaveBeenCalledWith(sighting.assetId, [sighting.trackId], true);
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(petId);
    expect(mocks.pet.cleanupEmptyPets).toHaveBeenCalled();
  });

  it('queues existing sightings when asset access is granted', async () => {
    mocks.pet.getSightingsForSharedRecognition.mockReturnValue(makeStream([{ id: sighting.id }]));

    await sut.onSharedPetAccessChanged({ action: 'grant', assetIds: [sighting.assetId] });

    expect(mocks.pet.getSightingsForSharedRecognition).toHaveBeenCalledWith({ assetIds: [sighting.assetId] });
    expect(mocks.job.queueAll).toHaveBeenCalledWith([
      { name: JobName.PetRecognition, data: { id: sighting.id, deferred: false } },
    ]);
  });

  it('removes viewer identities when asset access is revoked', async () => {
    const petId = '60000000-0000-4000-8000-000000000003';
    mocks.pet.deleteSharedIdentitiesWithoutAccess.mockResolvedValue([petId]);

    await sut.onSharedPetAccessChanged({ action: 'revoke' });

    expect(mocks.pet.deleteSharedIdentitiesWithoutAccess).toHaveBeenCalled();
    expect(mocks.pet.refreshFeature).toHaveBeenCalledWith(petId);
    expect(mocks.pet.cleanupEmptyPets).toHaveBeenCalled();
  });

  it('recognizes a shared viewer even when the owner already assigned the sighting', async () => {
    const viewerId = '50000000-0000-4000-8000-000000000001';
    const viewerPetId = '60000000-0000-4000-8000-000000000001';
    mocks.pet.getSightingForRecognition.mockResolvedValue({ ...sighting, petId: viewerPetId });
    mocks.person.getAdditionalAccessUserIds.mockResolvedValue([viewerId]);
    mocks.pet.hasIdentityForUser.mockResolvedValue(false);
    mocks.pet.search.mockResolvedValue([]);
    mocks.pet.searchCentroids.mockResolvedValue({ petId: viewerPetId, distance: 0.05 });

    await expect(sut.handleRecognizePet({ id: sighting.id, deferred: false })).resolves.toBe(JobStatus.Skipped);

    expect(mocks.pet.assignIdentity).toHaveBeenCalledWith(sighting.id, viewerPetId, viewerId);
    expect(mocks.pet.assign).not.toHaveBeenCalled();
  });

  it('does not chain an owner sighting through a nearby cluster member when the centroid does not match', async () => {
    mocks.pet.getSightingForRecognition.mockResolvedValue(sighting);
    mocks.pet.search.mockResolvedValue([
      { id: sighting.id, petId: null, distance: 0 },
      { id: 'nearby-member', petId: '60000000-0000-4000-8000-000000000004', distance: 0.04 },
    ]);

    await expect(sut.handleRecognizePet({ id: sighting.id, deferred: true })).resolves.toBe(JobStatus.Success);

    expect(mocks.pet.assign).not.toHaveBeenCalled();
  });

  it('creates an owner pet from a core cluster and assigns the sighting', async () => {
    const petId = '60000000-0000-4000-8000-000000000002';
    mocks.pet.getSightingForRecognition.mockResolvedValue(sighting);
    mocks.pet.search.mockResolvedValue([
      { id: sighting.id, petId: null, distance: 0 },
      { id: 'match-2', petId: null, distance: 0.04 },
      { id: 'match-3', petId: null, distance: 0.06 },
    ]);
    mocks.pet.create.mockResolvedValue({
      id: petId,
      ownerId: sighting.asset.ownerId,
      name: '',
      species: 'dog',
      isHidden: false,
      featurePetAssetId: sighting.id,
      createdAt: new Date(),
      updatedAt: new Date(),
      updateId: '70000000-0000-4000-8000-000000000001',
    });

    await expect(sut.handleRecognizePet({ id: sighting.id, deferred: false })).resolves.toBe(JobStatus.Success);

    expect(mocks.pet.create).toHaveBeenCalledWith({
      ownerId: sighting.asset.ownerId,
      species: 'dog',
      featurePetAssetId: sighting.id,
    });
    expect(mocks.pet.assign).toHaveBeenCalledWith(sighting.id, petId);
  });
});
