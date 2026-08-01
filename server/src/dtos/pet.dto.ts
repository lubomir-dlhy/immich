import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export const PetResponseSchema = z
  .object({
    id: z.uuidv4(),
    name: z.string(),
    species: z.string(),
    isHidden: z.boolean(),
    featurePetAssetId: z.uuidv4().nullable(),
    featureAssetId: z.uuidv4().nullish(),
    featureIsVideo: z.boolean().optional(),
    featureFrameTimestampMs: z.int().optional(),
    imageWidth: z.int().optional(),
    imageHeight: z.int().optional(),
    boundingBoxX1: z.int().optional(),
    boundingBoxY1: z.int().optional(),
    boundingBoxX2: z.int().optional(),
    boundingBoxY2: z.int().optional(),
    assetCount: z.coerce.number().optional(),
  })
  .meta({ id: 'PetResponseDto' });

export class PetResponseDto extends createZodDto(PetResponseSchema) {}

export const PetClusterNeighborSchema = z
  .object({
    petId: z.uuidv4(),
    distance: z.number(),
  })
  .meta({ id: 'PetClusterNeighborDto' });

export const PetClusterPointSchema = PetResponseSchema.extend({
  x: z.number(),
  y: z.number(),
  nearestPetId: z.uuidv4().nullable(),
  nearestDistance: z.number().nullable(),
  neighbors: z.array(PetClusterNeighborSchema),
}).meta({ id: 'PetClusterPointDto' });

export class PetClusterPointDto extends createZodDto(PetClusterPointSchema) {}

export const PetClusterResponseSchema = z
  .object({
    points: z.array(PetClusterPointSchema),
    recognitionThreshold: z.number(),
  })
  .meta({ id: 'PetClusterResponseDto' });

export class PetClusterResponseDto extends createZodDto(PetClusterResponseSchema) {}

export const AssetPetResponseSchema = z
  .object({
    id: z.uuidv4(),
    assetId: z.uuidv4(),
    imageWidth: z.int(),
    imageHeight: z.int(),
    boundingBoxX1: z.int(),
    boundingBoxY1: z.int(),
    boundingBoxX2: z.int(),
    boundingBoxY2: z.int(),
    detectionScore: z.number(),
    species: z.string(),
    trackId: z.uuidv4(),
    frameTimestampMs: z.int(),
    frameDurationMs: z.int().nullable(),
    pet: PetResponseSchema.nullable(),
  })
  .meta({ id: 'AssetPetResponseDto' });

export class AssetPetResponseDto extends createZodDto(AssetPetResponseSchema) {}

const AssetPetCreateSchema = z
  .object({
    assetId: z.uuidv4(),
    petId: z.uuidv4().optional(),
    species: z.enum(['cat', 'dog']),
    imageWidth: z.int().positive(),
    imageHeight: z.int().positive(),
    x: z.int().min(0),
    y: z.int().min(0),
    width: z.int().positive(),
    height: z.int().positive(),
    frameTimestampMs: z.int().min(0).optional(),
    frameDurationMs: z.int().positive().max(60_000).optional(),
  })
  .meta({ id: 'AssetPetCreateDto' });

export class AssetPetCreateDto extends createZodDto(AssetPetCreateSchema) {}

const PetUpdateSchema = z
  .object({
    name: z.string().trim().max(100).optional(),
    isHidden: z.boolean().optional(),
    species: z.enum(['cat', 'dog']).optional(),
  })
  .meta({ id: 'PetUpdateDto' });

export class PetUpdateDto extends createZodDto(PetUpdateSchema) {}

const PetMergeSchema = z
  .object({
    ids: z.array(z.uuidv4()).min(1).describe('Pet IDs to merge into the selected pet'),
  })
  .meta({ id: 'PetMergeDto' });

export class PetMergeDto extends createZodDto(PetMergeSchema) {}

const PetReassignSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).describe('Assets whose pet sightings should be moved'),
    targetPetId: z.uuidv4().optional().describe('Existing destination pet; omit to create a new pet'),
  })
  .meta({ id: 'PetReassignDto' });

export class PetReassignDto extends createZodDto(PetReassignSchema) {}

const PetRejectAppearancesSchema = z
  .object({
    assetIds: z.array(z.uuidv4()).min(1).describe('Assets whose matching pet appearances should be rejected'),
  })
  .meta({ id: 'PetRejectAppearancesDto' });

export class PetRejectAppearancesDto extends createZodDto(PetRejectAppearancesSchema) {}

export const PetRejectAppearancesResponseSchema = z
  .object({
    rejected: z.int().min(0),
  })
  .meta({ id: 'PetRejectAppearancesResponseDto' });

export class PetRejectAppearancesResponseDto extends createZodDto(PetRejectAppearancesResponseSchema) {}

const PetTrackSelectorSchema = z.object({
  assetId: z.uuidv4(),
  trackId: z.uuidv4(),
});

const PetTrackAssignmentTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('existing'),
    petId: z.uuidv4(),
  }),
  z.object({
    type: z.literal('new'),
    species: z.enum(['cat', 'dog']),
    name: z.string().trim().max(100).optional(),
  }),
  z.object({
    type: z.literal('unassigned'),
  }),
  z.object({
    type: z.literal('rejected'),
  }),
  z.object({
    type: z.literal('restore'),
  }),
  z.object({
    type: z.literal('species'),
    species: z.enum(['cat', 'dog']),
  }),
]);

const PetTrackAssignmentSchema = z
  .object({
    selectors: z.array(PetTrackSelectorSchema).min(1),
    target: PetTrackAssignmentTargetSchema,
  })
  .meta({ id: 'PetTrackAssignmentDto' });

export class PetTrackAssignmentDto extends createZodDto(PetTrackAssignmentSchema) {}

export const PetSuggestionSchema = z
  .object({
    pet: PetResponseSchema,
    distance: z.number(),
  })
  .meta({ id: 'PetSuggestionDto' });

export class PetSuggestionDto extends createZodDto(PetSuggestionSchema) {}

const PetTrackParamsSchema = z.object({
  id: z.uuidv4(),
  trackId: z.uuidv4(),
});

export class PetTrackParamsDto extends createZodDto(PetTrackParamsSchema) {}

const PetRecognitionRunSchema = z
  .object({
    force: z.boolean().default(false),
    recluster: z
      .boolean()
      .default(false)
      .describe('Rebuild pet identities from existing embeddings while preserving named pet anchors'),
  })
  .meta({ id: 'PetRecognitionRunDto' });

export class PetRecognitionRunDto extends createZodDto(PetRecognitionRunSchema) {}
