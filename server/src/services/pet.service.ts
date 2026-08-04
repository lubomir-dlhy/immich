import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import AsyncLock from 'async-lock';
import { Insertable } from 'kysely';
import { MachineLearningConfig } from 'src/config';
import { JOBS_ASSET_PAGINATION_SIZE } from 'src/constants';
import { OnEvent, OnJob } from 'src/decorators';
import { AuthDto } from 'src/dtos/auth.dto';
import {
  AssetPetCreateDto,
  AssetPetResponseDto,
  PetClusterResponseDto,
  PetMergeDto,
  PetReassignDto,
  PetRecognitionRunDto,
  PetRejectAppearancesDto,
  PetRejectAppearancesResponseDto,
  PetResponseDto,
  PetSuggestionDto,
  PetTrackAssignmentDto,
  PetUpdateDto,
} from 'src/dtos/pet.dto';
import { AssetType, AssetVisibility, JobName, JobStatus, Permission, QueueName, VectorIndex } from 'src/enum';
import { ArgOf } from 'src/repositories/event.repository';
import { AssetPetTable } from 'src/schema/tables/asset-pet.table';
import { PetSearchTable } from 'src/schema/tables/pet-search.table';
import { BaseService } from 'src/services/base.service';
import { JobItem, JobOf } from 'src/types';
import { isPetRecognitionEnabled } from 'src/utils/misc';

const PET_VIDEO_FRAME_INTERVAL_MS = 5000;
const PET_VIDEO_MAX_FRAMES = 120;
// Temporal matching is deliberately looser than global identity clustering:
// consecutive frames already provide a strong time constraint, while pose and
// motion blur can move AnimalID embeddings substantially within one video.
const PET_VIDEO_TRACK_MAX_DISTANCE = 0.55;
const PET_VIDEO_TRACK_MAX_GAP_MS = PET_VIDEO_FRAME_INTERVAL_MS * 2;
// Manual refresh is an explicit request to look again. If the configured pass
// finds nothing, retry at a conservative lower threshold before concluding
// that the asset has no pets. Automatic ingestion keeps the configured score.
const PET_REFRESH_FALLBACK_MIN_SCORE = 0.35;

type PetVideoTrack = {
  id: string;
  species: string;
  embedding: number[];
  samples: number;
  lastTimestampMs: number;
};

const parseEmbedding = (embedding: string): number[] => {
  try {
    const values = JSON.parse(embedding);
    return Array.isArray(values) ? values.map(Number) : [];
  } catch {
    return [];
  }
};

const cosineDistance = (left: number[], right: number[]): number => {
  if (left.length === 0 || left.length !== right.length) {
    return Infinity;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (const [index, value] of left.entries()) {
    dot += value * right[index];
    leftNorm += value * value;
    rightNorm += right[index] * right[index];
  }
  return 1 - dot / Math.max(Math.sqrt(leftNorm * rightNorm), Number.EPSILON);
};

const projectDistances = (distances: number[][]): Array<[number, number]> => {
  const size = distances.length;
  if (size <= 1) {
    return size === 0 ? [] : [[0, 0]];
  }

  const squared = distances.map((row) => row.map((distance) => distance * distance));
  const rowMeans = squared.map((row) => row.reduce((sum, value) => sum + value, 0) / size);
  const totalMean = rowMeans.reduce((sum, value) => sum + value, 0) / size;
  let matrix = squared.map((row, rowIndex) =>
    row.map((value, columnIndex) => -0.5 * (value - rowMeans[rowIndex] - rowMeans[columnIndex] + totalMean)),
  );

  const components: Array<{ value: number; vector: number[] }> = [];
  for (let component = 0; component < 2; component++) {
    let vector = Array.from({ length: size }, (_, index) => Math.sin((index + 1) * (component + 1) * 1.618));
    for (let iteration = 0; iteration < 80; iteration++) {
      const next = matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
      const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
      if (norm <= Number.EPSILON) {
        break;
      }
      vector = next.map((value) => value / norm);
    }
    const multiplied = matrix.map((row) => row.reduce((sum, value, index) => sum + value * vector[index], 0));
    const value = vector.reduce((sum, coordinate, index) => sum + coordinate * multiplied[index], 0);
    components.push({ value: Math.max(0, value), vector });
    matrix = matrix.map((row, rowIndex) =>
      row.map((entry, columnIndex) => entry - Math.max(0, value) * vector[rowIndex] * vector[columnIndex]),
    );
  }

  const coordinates = Array.from({ length: size }, (_, index) => [
    components[0].vector[index] * Math.sqrt(components[0].value),
    components[1].vector[index] * Math.sqrt(components[1].value),
  ]) as Array<[number, number]>;
  const scale = Math.max(1e-6, ...coordinates.flatMap(([x, y]) => [Math.abs(x), Math.abs(y)]));
  return coordinates.map(([x, y]) => [x / scale, y / scale]);
};

const updateTrackEmbedding = (track: PetVideoTrack, embedding: number[]) => {
  const samples = track.samples + 1;
  const averaged = track.embedding.map((value, index) => (value * track.samples + embedding[index]) / samples);
  const norm = Math.sqrt(averaged.reduce((sum, value) => sum + value * value, 0));
  track.embedding = norm > 0 ? averaged.map((value) => value / norm) : averaged;
  track.samples = samples;
};

const getIntersectionOverUnion = (
  left: { boundingBoxX1: number; boundingBoxY1: number; boundingBoxX2: number; boundingBoxY2: number },
  right: { boundingBox: { x1: number; y1: number; x2: number; y2: number } },
) => {
  const intersectionWidth = Math.max(
    0,
    Math.min(left.boundingBoxX2, right.boundingBox.x2) - Math.max(left.boundingBoxX1, right.boundingBox.x1),
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(left.boundingBoxY2, right.boundingBox.y2) - Math.max(left.boundingBoxY1, right.boundingBox.y1),
  );
  const intersection = intersectionWidth * intersectionHeight;
  const leftArea =
    Math.max(0, left.boundingBoxX2 - left.boundingBoxX1) * Math.max(0, left.boundingBoxY2 - left.boundingBoxY1);
  const rightArea =
    Math.max(0, right.boundingBox.x2 - right.boundingBox.x1) * Math.max(0, right.boundingBox.y2 - right.boundingBox.y1);
  return intersection / Math.max(leftArea + rightArea - intersection, Number.EPSILON);
};

const getPetVideoFrameTimes = (durationMs: number | null): number[] => {
  if (!durationMs || durationMs <= 0) {
    return [0];
  }

  const intervalMs = Math.max(PET_VIDEO_FRAME_INTERVAL_MS, Math.ceil(durationMs / PET_VIDEO_MAX_FRAMES / 1000) * 1000);
  return Array.from({ length: Math.ceil(durationMs / intervalMs) }, (_, index) => index * intervalMs);
};

@Injectable()
export class PetService extends BaseService {
  private readonly videoDetectionLock = new AsyncLock();
  private readonly recognitionLock = new AsyncLock();

  @OnEvent({ name: 'SharedFaceAccessChanged' })
  async onSharedPetAccessChanged({ action, ...options }: ArgOf<'SharedFaceAccessChanged'>): Promise<void> {
    if (action === 'revoke') {
      const affectedPetIds = await this.petRepository.deleteSharedIdentitiesWithoutAccess();
      for (const petId of affectedPetIds) {
        await this.petRepository.refreshFeature(petId);
      }
      await this.petRepository.cleanupEmptyPets();
      return;
    }

    await this.queueSharedPetRecognition(options);
  }

  async getAll(auth: AuthDto): Promise<PetResponseDto[]> {
    const pets = await this.petRepository.getAllPets(auth.user.id);
    return pets.map(({ assetCount, feature, ...pet }) => ({
      ...pet,
      assetCount: assetCount ?? 0,
      featureAssetId: feature?.assetId,
      featureIsVideo: feature?.type === AssetType.Video,
      featureFrameTimestampMs: feature?.frameTimestampMs,
      imageWidth: feature?.imageWidth,
      imageHeight: feature?.imageHeight,
      boundingBoxX1: feature?.boundingBoxX1,
      boundingBoxY1: feature?.boundingBoxY1,
      boundingBoxX2: feature?.boundingBoxX2,
      boundingBoxY2: feature?.boundingBoxY2,
    }));
  }

  async getClusters(auth: AuthDto): Promise<PetClusterResponseDto> {
    const [pets, centroids] = await Promise.all([
      this.getAll(auth),
      this.petRepository.getClusterCentroids(auth.user.id),
    ]);
    const petById = new Map(pets.map((pet) => [pet.id, pet]));
    const entries = centroids
      .map(({ petId, embedding }) => {
        const pet = petById.get(petId);
        return pet ? { pet, vector: parseEmbedding(embedding) } : undefined;
      })
      .filter((entry): entry is { pet: PetResponseDto; vector: number[] } => !!entry && entry.vector.length > 0);
    const distances = entries.map((left) =>
      entries.map((right) => (left === right ? 0 : cosineDistance(left.vector, right.vector))),
    );
    const coordinates = projectDistances(distances);
    const { machineLearning } = await this.getConfig({ withCache: true });

    return {
      recognitionThreshold: machineLearning.petRecognition.maxDistance,
      points: entries.map(({ pet }, index) => {
        const rankedNeighbors = entries
          .map((candidate, candidateIndex) => ({
            petId: candidate.pet.id,
            species: candidate.pet.species,
            isHidden: candidate.pet.isHidden,
            distance: distances[index][candidateIndex],
          }))
          .filter((candidate) => candidate.petId !== pet.id && candidate.species === pet.species)
          .sort((left, right) => left.distance - right.distance);
        const neighbors = [
          ...rankedNeighbors.filter(({ isHidden }) => !isHidden),
          ...rankedNeighbors.filter(({ isHidden }) => isHidden),
        ]
          .sort((left, right) => left.distance - right.distance)
          .map(({ petId, distance }) => ({ petId, distance }));

        return {
          ...pet,
          x: coordinates[index]?.[0] ?? 0,
          y: coordinates[index]?.[1] ?? 0,
          nearestPetId: neighbors[0]?.petId ?? null,
          nearestDistance: neighbors[0]?.distance ?? null,
          neighbors,
        };
      }),
    };
  }

  async getThumbnail(auth: AuthDto, id: string): Promise<Buffer> {
    const feature = await this.petRepository.getPetFeature(auth.user.id, id);
    if (!feature || feature.type !== AssetType.Video) {
      throw new NotFoundException('Video pet thumbnail not found');
    }

    return this.mediaRepository.extractVideoFrame(feature.originalPath, feature.frameTimestampMs);
  }

  async getSightingThumbnail(auth: AuthDto, id: string): Promise<Buffer> {
    const sighting = await this.petRepository.getSightingThumbnailSource(id);
    if (!sighting) {
      throw new NotFoundException('Pet sighting not found');
    }

    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [sighting.assetId] });
    if (sighting.type !== AssetType.Video) {
      throw new BadRequestException('Pet sighting thumbnail is only available for videos');
    }

    return this.mediaRepository.extractVideoFrame(sighting.originalPath, sighting.frameTimestampMs);
  }

  async getById(auth: AuthDto, id: string): Promise<PetResponseDto> {
    const [result] = await this.petRepository.getAllPets(auth.user.id, id);
    if (!result) {
      throw new NotFoundException('Pet not found');
    }

    const { assetCount, feature, ...pet } = result;
    return {
      ...pet,
      assetCount: assetCount ?? 0,
      featureAssetId: feature?.assetId,
      featureIsVideo: feature?.type === AssetType.Video,
      featureFrameTimestampMs: feature?.frameTimestampMs,
      imageWidth: feature?.imageWidth,
      imageHeight: feature?.imageHeight,
      boundingBoxX1: feature?.boundingBoxX1,
      boundingBoxY1: feature?.boundingBoxY1,
      boundingBoxX2: feature?.boundingBoxX2,
      boundingBoxY2: feature?.boundingBoxY2,
    };
  }

  async getAssetPets(auth: AuthDto, assetId: string): Promise<AssetPetResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    return this.petRepository.getAssetPets(assetId, auth.user.id);
  }

  async getTrackSuggestions(auth: AuthDto, assetId: string, trackId: string): Promise<PetSuggestionDto[]> {
    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [assetId] });
    const asset = await this.petRepository.getAssetForDetection(assetId);
    const sighting = asset?.pets.find((pet) => pet.trackId === trackId && !pet.isRejected);
    if (!asset || !sighting) {
      throw new NotFoundException('Pet track not found');
    }

    const embedding = await this.petRepository.getTrackEmbedding(assetId, trackId);
    if (!embedding) {
      return [];
    }

    const { machineLearning } = await this.getConfig({ withCache: true });
    const matches = await this.petRepository.searchIdentityCandidates(
      auth.user.id,
      sighting.species,
      embedding,
      machineLearning.petRecognition.maxDistance,
      8,
    );
    const assetPets = await this.petRepository.getAssetPets(assetId, auth.user.id);
    const currentPet = assetPets.find((pet) => pet.trackId === trackId)?.pet;
    const pets = await this.getAll(auth);
    const petById = new Map(pets.map((pet) => [pet.id, pet]));

    return matches
      .filter(({ petId }) => petId !== currentPet?.id)
      .map(({ petId, distance }) => ({ pet: petById.get(petId), distance }))
      .filter((suggestion): suggestion is PetSuggestionDto => !!suggestion.pet)
      .slice(0, 3);
  }

  async assignTracks(auth: AuthDto, dto: PetTrackAssignmentDto): Promise<AssetPetResponseDto[]> {
    const groupedSelectors = new Map<string, Set<string>>();
    for (const { assetId, trackId } of dto.selectors) {
      const trackIds = groupedSelectors.get(assetId) ?? new Set<string>();
      trackIds.add(trackId);
      groupedSelectors.set(assetId, trackIds);
    }

    const permission = ['rejected', 'restore', 'species'].includes(dto.target.type)
      ? Permission.AssetUpdate
      : Permission.AssetRead;
    await this.requireAccess({ auth, permission, ids: groupedSelectors.keys().toArray() });

    const assets = [];
    const selectedSightings = [];
    for (const [assetId, trackIds] of groupedSelectors) {
      const asset = await this.petRepository.getAssetForDetection(assetId);
      if (!asset) {
        throw new NotFoundException('Asset not found');
      }
      const sightings = asset.pets.filter(({ trackId }) => trackIds.has(trackId));
      if (new Set(sightings.map(({ trackId }) => trackId)).size !== trackIds.size) {
        throw new NotFoundException('Pet track not found');
      }
      if ((dto.target.type === 'rejected' || dto.target.type === 'restore') && asset.ownerId !== auth.user.id) {
        throw new BadRequestException('Only the asset owner can reject pet tracks');
      }
      if (dto.target.type === 'species' && asset.ownerId !== auth.user.id) {
        throw new BadRequestException('Only the asset owner can correct pet species');
      }
      assets.push({ asset, trackIds });
      selectedSightings.push(...sightings);
    }

    let targetPet;
    if (dto.target.type === 'existing') {
      targetPet = await this.petRepository.getPet(auth.user.id, dto.target.petId);
      if (!targetPet) {
        throw new NotFoundException('Pet not found');
      }
    } else if (dto.target.type === 'new') {
      const targetSpecies = dto.target.species;
      if (selectedSightings.some(({ species }) => species !== targetSpecies)) {
        throw new BadRequestException('Pet species does not match the selected track');
      }
      targetPet = await this.petRepository.create({
        ownerId: auth.user.id,
        name: dto.target.name ?? '',
        species: dto.target.species,
      });
    }

    if (targetPet && selectedSightings.some(({ species }) => species !== targetPet.species)) {
      throw new BadRequestException('Pet species does not match the selected track');
    }

    const affectedPetIds = new Set<string>();
    for (const { asset, trackIds } of assets) {
      const visiblePets = await this.petRepository.getAssetPets(asset.id, auth.user.id);
      for (const { trackId } of visiblePets) {
        if (!trackIds.has(trackId)) {
          continue;
        }

        const petId = visiblePets.find((pet) => pet.trackId === trackId)?.pet?.id;
        if (petId) {
          affectedPetIds.add(petId);
        }
      }

      if (dto.target.type === 'rejected' || dto.target.type === 'restore') {
        await this.petRepository.setTracksRejected(asset.id, [...trackIds], dto.target.type === 'rejected');
        continue;
      }

      if (dto.target.type === 'species') {
        const petIds = await this.petRepository.updateTrackSpecies(asset.id, [...trackIds], dto.target.species);
        for (const petId of petIds) {
          affectedPetIds.add(petId);
        }
        continue;
      }

      for (const trackId of trackIds) {
        await (targetPet
          ? this.petRepository.assignTrackIdentity(asset.id, trackId, targetPet.id, auth.user.id, asset.ownerId)
          : this.petRepository.unassignTrackIdentity(asset.id, trackId, auth.user.id, asset.ownerId));
      }
    }

    if (targetPet) {
      affectedPetIds.add(targetPet.id);
    }
    for (const petId of affectedPetIds) {
      await this.petRepository.refreshFeature(petId);
    }
    if (dto.target.type === 'species') {
      await this.petRepository.cleanupEmptyPets();
    }

    const result = [];
    for (const assetId of groupedSelectors.keys()) {
      result.push(...(await this.petRepository.getAssetPets(assetId, auth.user.id)));
    }
    return result;
  }

  async unassignAssetPet(auth: AuthDto, id: string): Promise<void> {
    const sighting = await this.petRepository.getSightingForRecognition(id);
    if (!sighting) {
      throw new NotFoundException('Pet sighting not found');
    }

    await this.requireAccess({ auth, permission: Permission.AssetRead, ids: [sighting.assetId] });
    const assetPets = await this.petRepository.getAssetPets(sighting.assetId, auth.user.id);
    const assignedSighting = assetPets.find(({ id: sightingId }) => sightingId === id);
    if (!assignedSighting?.pet) {
      throw new NotFoundException('Pet sighting assignment not found');
    }

    await this.petRepository.unassignIdentity(id, assignedSighting.pet.id, auth.user.id);
    await this.petRepository.refreshFeature(assignedSighting.pet.id);
    await this.petRepository.cleanupEmptyPets();
  }

  async createAssetPet(auth: AuthDto, dto: AssetPetCreateDto): Promise<AssetPetResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: [dto.assetId] });

    const asset = await this.petRepository.getAssetForDetection(dto.assetId);
    const preview = asset?.files[0];
    if (!asset || !preview) {
      throw new BadRequestException('Asset preview not found');
    }
    if (asset.ownerId !== auth.user.id) {
      throw new BadRequestException('Only the asset owner can annotate pets');
    }

    let pet = dto.petId ? await this.petRepository.getPet(auth.user.id, dto.petId) : undefined;
    if (dto.petId && !pet) {
      throw new BadRequestException('Pet not found');
    }
    if (pet && pet.species !== dto.species) {
      throw new BadRequestException('Pet species does not match the annotation');
    }

    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPetRecognitionEnabled(machineLearning)) {
      throw new BadRequestException('Pet recognition is disabled');
    }

    const recognitionInput =
      asset.type === AssetType.Video && dto.frameTimestampMs !== undefined
        ? await this.mediaRepository.extractVideoFrame(asset.originalPath, dto.frameTimestampMs)
        : preview.path;
    const result = await this.machineLearningRepository.recognizePetRegion(
      recognitionInput,
      machineLearning.petRecognition,
      { ...dto, species: dto.species },
    );
    if (!result.pet) {
      throw new BadRequestException('Could not embed the selected pet region');
    }

    pet ??= await this.petRepository.create({ ownerId: auth.user.id, species: dto.species });
    const id = this.cryptoRepository.randomUUID();
    await this.petRepository.createSighting(
      {
        id,
        assetId: dto.assetId,
        petId: pet.id,
        imageWidth: result.imageWidth,
        imageHeight: result.imageHeight,
        boundingBoxX1: result.pet.boundingBox.x1,
        boundingBoxY1: result.pet.boundingBox.y1,
        boundingBoxX2: result.pet.boundingBox.x2,
        boundingBoxY2: result.pet.boundingBox.y2,
        detectionScore: 1,
        species: dto.species,
        trackId: id,
        frameTimestampMs: dto.frameTimestampMs ?? 0,
        frameDurationMs: dto.frameTimestampMs === undefined ? null : (dto.frameDurationMs ?? 1000),
      },
      { petAssetId: id, embedding: result.pet.embedding },
    );

    const sightings = await this.petRepository.getAssetPets(dto.assetId, auth.user.id);
    const created = sightings.find((sighting) => sighting.id === id);
    if (!created) {
      throw new BadRequestException('Created pet sighting not found');
    }
    return created;
  }

  async update(auth: AuthDto, id: string, dto: PetUpdateDto): Promise<PetResponseDto> {
    const pet = await this.petRepository.getPet(auth.user.id, id);
    if (!pet) {
      throw new BadRequestException('Pet not found');
    }
    return this.petRepository.update({ id, ...dto });
  }

  async merge(auth: AuthDto, id: string, dto: PetMergeDto): Promise<PetResponseDto> {
    if (dto.ids.includes(id)) {
      throw new BadRequestException('Cannot merge a pet into itself');
    }

    let target = await this.petRepository.getPet(auth.user.id, id);
    if (!target) {
      throw new BadRequestException('Pet not found');
    }

    const sources = [];
    for (const sourceId of new Set(dto.ids)) {
      const source = await this.petRepository.getPet(auth.user.id, sourceId);
      if (!source) {
        throw new BadRequestException(`Pet not found: ${sourceId}`);
      }
      if (source.species !== target.species) {
        throw new BadRequestException('Cannot merge pets of different species');
      }
      sources.push(source);
    }

    if (!target.name) {
      const namedSource = sources.find(({ name }) => !!name);
      if (namedSource) {
        target = await this.petRepository.update({ id, name: namedSource.name });
      }
    }

    await this.petRepository.merge(
      id,
      sources.map(({ id }) => id),
    );
    const pets = await this.getAll(auth);
    const merged = pets.find((pet) => pet.id === target.id);
    if (!merged) {
      throw new BadRequestException('Merged pet not found');
    }
    return merged;
  }

  async reassign(auth: AuthDto, id: string, dto: PetReassignDto): Promise<PetResponseDto> {
    const source = await this.petRepository.getPet(auth.user.id, id);
    if (!source) {
      throw new BadRequestException('Pet not found');
    }
    if (!(await this.petRepository.hasSightings(id, dto.assetIds))) {
      throw new BadRequestException('No matching pet sightings found');
    }

    let target;
    if (dto.targetPetId) {
      if (dto.targetPetId === id) {
        throw new BadRequestException('Cannot reassign pet sightings to the same pet');
      }
      target = await this.petRepository.getPet(auth.user.id, dto.targetPetId);
      if (!target) {
        throw new BadRequestException('Target pet not found');
      }
      if (target.species !== source.species) {
        throw new BadRequestException('Cannot reassign pet sightings across different species');
      }
    } else {
      target = await this.petRepository.create({ ownerId: auth.user.id, species: source.species });
    }

    await this.petRepository.reassignSightings(id, target.id, dto.assetIds);
    await this.petRepository.refreshFeature(id);
    await this.petRepository.refreshFeature(target.id);
    await this.petRepository.cleanupEmptyPets();

    const pets = await this.getAll(auth);
    const reassigned = pets.find(({ id: petId }) => petId === target.id);
    if (!reassigned) {
      throw new BadRequestException('Reassigned pet not found');
    }
    return reassigned;
  }

  async rejectAppearances(
    auth: AuthDto,
    id: string,
    dto: PetRejectAppearancesDto,
  ): Promise<PetRejectAppearancesResponseDto> {
    const source = await this.petRepository.getPet(auth.user.id, id);
    if (!source) {
      throw new BadRequestException('Pet not found');
    }

    const assetIds = [...new Set(dto.assetIds)];
    await this.requireAccess({ auth, permission: Permission.AssetUpdate, ids: assetIds });

    let rejected = 0;
    for (const assetId of assetIds) {
      const asset = await this.petRepository.getAssetForDetection(assetId);
      if (!asset) {
        throw new NotFoundException('Asset not found');
      }
      if (asset.ownerId !== auth.user.id) {
        throw new BadRequestException('Only the asset owner can reject pet tracks');
      }

      const visiblePets = await this.petRepository.getAssetPets(assetId, auth.user.id);
      const trackIds = [...new Set(visiblePets.filter(({ pet }) => pet?.id === id).map(({ trackId }) => trackId))];
      if (trackIds.length === 0) {
        continue;
      }

      await this.petRepository.setTracksRejected(assetId, trackIds, true);
      rejected += trackIds.length;
    }

    if (rejected === 0) {
      throw new BadRequestException('No matching pet appearances found');
    }

    await this.petRepository.refreshFeature(id);
    await this.petRepository.cleanupEmptyPets();
    return { rejected };
  }

  async runRecognition(_: AuthDto, dto: PetRecognitionRunDto): Promise<void> {
    if (dto.recluster) {
      await this.jobRepository.queue({
        name: JobName.PetRecognitionQueueAll,
        data: { force: true },
      });
      return;
    }

    await this.jobRepository.queue({
      name: JobName.AssetDetectPetsQueueAll,
      data: { force: dto.force },
    });
  }

  @OnJob({ name: JobName.AssetDetectPetsQueueAll, queue: QueueName.FaceDetection })
  async handleQueueDetectPets({ force }: JobOf<JobName.AssetDetectPetsQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isPetRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    if (force) {
      await this.petRepository.deleteAllDetections();
    }

    let jobs: JobItem[] = [];
    for await (const asset of this.petRepository.streamAssetsForDetection(force)) {
      jobs.push({ name: JobName.AssetDetectPets, data: { id: asset.id, force } });
      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }
    await this.jobRepository.queueAll(jobs);
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.AssetDetectPets, queue: QueueName.FaceDetection })
  async handleDetectPets({ id, force }: JobOf<JobName.AssetDetectPets>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPetRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const asset = await this.petRepository.getAssetForDetection(id);
    if (!asset) {
      return JobStatus.Failed;
    }

    const detect = async () => {
      const sightings: Array<Insertable<AssetPetTable> & { id: string }> = [];
      const embeddings: PetSearchTable[] = [];
      const videoTracks: PetVideoTrack[] = [];
      const processFrame = async (input: string | Buffer, frameTimestampMs: number, frameDurationMs: number | null) => {
        let detectionConfig = machineLearning.petRecognition;
        let result = await this.machineLearningRepository.detectPets(input, detectionConfig);
        if (force && result.pets.length === 0 && detectionConfig.minScore > PET_REFRESH_FALLBACK_MIN_SCORE) {
          detectionConfig = { ...detectionConfig, minScore: PET_REFRESH_FALLBACK_MIN_SCORE };
          result = await this.machineLearningRepository.detectPets(input, detectionConfig);
          this.logger.debug(`Retried pet detection for asset ${id} at score ${PET_REFRESH_FALLBACK_MIN_SCORE}`);
        }

        const { imageHeight, imageWidth } = result;
        // YOLOX can return a low combined class score after its objectness
        // pre-filter. Enforce the requested final confidence here as well.
        const pets = result.pets.filter(({ score }) => score >= detectionConfig.minScore);
        const detections = force
          ? pets
          : pets.filter((detection) =>
              asset.pets.every(
                (existing) =>
                  !(
                    existing.isRejected &&
                    existing.frameTimestampMs === frameTimestampMs &&
                    existing.species === detection.species &&
                    getIntersectionOverUnion(existing, detection) >= 0.5
                  ),
              ),
            );

        const detectionEmbeddings = detections.map(({ embedding }) => parseEmbedding(embedding));
        const recentTracks = videoTracks.filter(
          ({ lastTimestampMs }) => frameTimestampMs - lastTimestampMs <= PET_VIDEO_TRACK_MAX_GAP_MS,
        );
        const candidates = detections
          .flatMap((detection, detectionIndex) =>
            recentTracks
              .filter(({ species }) => species === detection.species)
              .map((track) => ({
                detectionIndex,
                track,
                distance: cosineDistance(detectionEmbeddings[detectionIndex], track.embedding),
              })),
          )
          .filter(({ distance }) => distance <= PET_VIDEO_TRACK_MAX_DISTANCE)
          .sort((left, right) => left.distance - right.distance);
        const matches = new Map<number, PetVideoTrack>();
        const matchedTrackIds = new Set<string>();
        for (const { detectionIndex, track } of candidates) {
          if (matches.has(detectionIndex) || matchedTrackIds.has(track.id)) {
            continue;
          }

          matches.set(detectionIndex, track);
          matchedTrackIds.add(track.id);
        }

        for (const [detectionIndex, detection] of detections.entries()) {
          const embedding = detectionEmbeddings[detectionIndex];
          let track = matches.get(detectionIndex);
          if (track) {
            updateTrackEmbedding(track, embedding);
            track.lastTimestampMs = frameTimestampMs;
          } else {
            track = {
              id: this.cryptoRepository.randomUUID(),
              species: detection.species,
              embedding,
              samples: 1,
              lastTimestampMs: frameTimestampMs,
            };
            videoTracks.push(track);
          }

          const petAssetId = this.cryptoRepository.randomUUID();
          sightings.push({
            id: petAssetId,
            assetId: id,
            petId: null,
            imageWidth,
            imageHeight,
            boundingBoxX1: detection.boundingBox.x1,
            boundingBoxY1: detection.boundingBox.y1,
            boundingBoxX2: detection.boundingBox.x2,
            boundingBoxY2: detection.boundingBox.y2,
            detectionScore: detection.score,
            species: detection.species,
            trackId: track.id,
            frameTimestampMs,
            frameDurationMs,
          });
          embeddings.push({ petAssetId, embedding: detection.embedding });
        }
      };

      if (asset.type === AssetType.Video) {
        const frameTimes = getPetVideoFrameTimes(asset.duration);
        for (const [frameIndex, frameTimestampMs] of frameTimes.entries()) {
          const frame = await this.mediaRepository.extractVideoFrame(asset.originalPath, frameTimestampMs);
          const nextTimestampMs = frameTimes[frameIndex + 1] ?? asset.duration;
          const frameDurationMs = nextTimestampMs == null ? null : Math.max(1, nextTimestampMs - frameTimestampMs);
          await processFrame(frame, frameTimestampMs, frameDurationMs);
        }
      } else {
        const preview = asset.files[0];
        if (!preview) {
          return JobStatus.Failed;
        }
        await processFrame(preview.path, 0, null);
      }

      await this.petRepository.replaceAssetPets(id, sightings, embeddings, { discardRejected: force === true });
      await this.assetRepository.upsertJobStatus({ assetId: id, petsRecognizedAt: new Date() });
      this.websocketRepository.clientSend('on_pet_update', asset.ownerId, {
        assetId: id,
        pets: sightings.length,
      });

      if (sightings.length > 0) {
        const queuedTrackIds = new Set<string>();
        const trackRepresentatives = sightings.filter(({ trackId }) => {
          if (queuedTrackIds.has(trackId)) {
            return false;
          }
          queuedTrackIds.add(trackId);
          return true;
        });
        await this.jobRepository.queueAll([
          { name: JobName.PetRecognitionQueueAll, data: { force: false } },
          ...trackRepresentatives.map(
            ({ id }) => ({ name: JobName.PetRecognition, data: { id, deferred: false } }) as const,
          ),
        ]);
      }
      this.logger.debug(`Detected ${sightings.length} pets in asset ${id}`);
      return JobStatus.Success;
    };

    return asset.type === AssetType.Video ? this.videoDetectionLock.acquire('pet-video-detection', detect) : detect();
  }

  @OnJob({ name: JobName.PetRecognitionQueueAll, queue: QueueName.FacialRecognition })
  async handleQueueRecognizePets({ force }: JobOf<JobName.PetRecognitionQueueAll>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: false });
    if (!isPetRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }
    if (force) {
      await this.petRepository.resetRecognition();
    }

    await this.databaseRepository.prewarm(VectorIndex.Pet);
    let jobs: JobItem[] = [];
    const queueSightings = async (sightings: AsyncIterable<{ id: string }>) => {
      for await (const sighting of sightings) {
        jobs.push({ name: JobName.PetRecognition, data: { id: sighting.id, deferred: false } });
        if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
          await this.jobRepository.queueAll(jobs);
          jobs = [];
        }
      }
    };

    await queueSightings(this.petRepository.getAllUnassigned());
    await queueSightings(this.petRepository.getSightingsForSharedRecognition());
    await this.jobRepository.queueAll(jobs);
    await this.petRepository.cleanupEmptyPets();
    return JobStatus.Success;
  }

  @OnJob({ name: JobName.PetRecognition, queue: QueueName.FacialRecognition })
  async handleRecognizePet({ id, deferred }: JobOf<JobName.PetRecognition>): Promise<JobStatus> {
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isPetRecognitionEnabled(machineLearning)) {
      return JobStatus.Skipped;
    }

    const sighting = await this.petRepository.getSightingForRecognition(id);
    if (!sighting?.asset || !sighting.petSearch?.embedding) {
      return JobStatus.Failed;
    }
    const sightingEmbedding = sighting.petSearch.embedding;

    return this.recognitionLock.acquire(`${sighting.assetId}:${sighting.trackId}`, async () => {
      const trackPetId = await this.petRepository.getTrackPetId(sighting.assetId, sighting.trackId);
      if (trackPetId) {
        await this.petRepository.assign(id, trackPetId);
        return JobStatus.Success;
      }

      const embedding =
        (await this.petRepository.getTrackEmbedding(sighting.assetId, sighting.trackId)) ?? sightingEmbedding;
      return this.recognizePetSighting(sighting, embedding, deferred ?? false, machineLearning);
    });
  }

  private async recognizePetSighting(
    sighting: NonNullable<Awaited<ReturnType<typeof this.petRepository.getSightingForRecognition>>>,
    embedding: string,
    deferred: boolean,
    machineLearning: MachineLearningConfig,
  ): Promise<JobStatus> {
    if (!sighting.asset) {
      return JobStatus.Failed;
    }

    const sharedSighting = {
      id: sighting.id,
      embedding,
      species: sighting.species,
      visibility: sighting.asset.visibility,
    };
    const accessUserIds = await this.personRepository.getAdditionalAccessUserIds(
      sighting.assetId,
      sighting.asset.ownerId,
    );
    for (const userId of accessUserIds) {
      await this.recognizePetForUser(sharedSighting, userId, machineLearning);
    }

    if (sighting.petId) {
      return JobStatus.Skipped;
    }

    const config = machineLearning.petRecognition;
    const matches = await this.petRepository.search(sighting.asset.ownerId, embedding, {
      maxDistance: config.maxDistance,
      numResults: config.minPets,
      species: sighting.species,
    });
    if (config.minPets > 1 && matches.length <= 1) {
      return JobStatus.Skipped;
    }

    const isCore = matches.length >= config.minPets && sighting.asset.visibility === AssetVisibility.Timeline;
    if (!isCore && !deferred) {
      await this.jobRepository.queue({ name: JobName.PetRecognition, data: { id: sighting.id, deferred: true } });
      return JobStatus.Skipped;
    }

    const identityMatch = await this.petRepository.searchIdentityCandidates(
      sighting.asset.ownerId,
      sighting.species,
      embedding,
      config.maxDistance,
      1,
    );
    let petId = identityMatch.at(0)?.petId;

    if (isCore && !petId) {
      const pet = await this.petRepository.create({
        ownerId: sighting.asset.ownerId,
        species: sighting.species,
        featurePetAssetId: sighting.id,
      });
      petId = pet.id;
    }

    if (petId) {
      await this.petRepository.assign(sighting.id, petId);
    }
    return JobStatus.Success;
  }

  private async queueSharedPetRecognition(options: {
    assetIds?: string[];
    albumId?: string;
    ownerId?: string;
  }): Promise<void> {
    let jobs: JobItem[] = [];
    for await (const sighting of this.petRepository.getSightingsForSharedRecognition(options)) {
      jobs.push({ name: JobName.PetRecognition, data: { id: sighting.id, deferred: false } });
      if (jobs.length >= JOBS_ASSET_PAGINATION_SIZE) {
        await this.jobRepository.queueAll(jobs);
        jobs = [];
      }
    }
    await this.jobRepository.queueAll(jobs);
  }

  private async recognizePetForUser(
    sighting: { id: string; embedding: string; species: string; visibility: AssetVisibility },
    userId: string,
    machineLearning: MachineLearningConfig,
  ): Promise<void> {
    if (await this.petRepository.hasIdentityForUser(sighting.id, userId)) {
      return;
    }

    const config = machineLearning.petRecognition;
    const matches = await this.petRepository.search(userId, sighting.embedding, {
      maxDistance: config.maxDistance,
      numResults: config.minPets,
      species: sighting.species,
    });

    const identityMatch = await this.petRepository.searchIdentityCandidates(
      userId,
      sighting.species,
      sighting.embedding,
      config.maxDistance,
      1,
    );
    let petId = identityMatch.at(0)?.petId;

    const isCore = matches.length >= config.minPets && sighting.visibility === AssetVisibility.Timeline;
    if (!petId && isCore) {
      const pet = await this.petRepository.create({
        ownerId: userId,
        species: sighting.species,
        featurePetAssetId: sighting.id,
      });
      petId = pet.id;
    }

    if (petId) {
      await this.petRepository.assignIdentity(sighting.id, petId, userId);
    }
  }
}
