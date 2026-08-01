import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Endpoint, HistoryBuilder } from 'src/decorators';
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
  PetTrackParamsDto,
  PetUpdateDto,
} from 'src/dtos/pet.dto';
import { ApiTag, Permission } from 'src/enum';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard';
import { PetService } from 'src/services/pet.service';
import { UUIDParamDto } from 'src/validation';

@ApiTags(ApiTag.People)
@Controller('pets')
export class PetController {
  constructor(private service: PetService) {}

  @Get()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get all pets',
    description: 'Retrieve recognized pets owned by the current user.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getPets(@Auth() auth: AuthDto): Promise<PetResponseDto[]> {
    return this.service.getAll(auth);
  }

  @Get('clusters')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get the pet similarity map',
    description:
      'Project pet identity centroids into two dimensions and include exact nearest-neighbor cosine distances.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getPetClusters(@Auth() auth: AuthDto): Promise<PetClusterResponseDto> {
    return this.service.getClusters(auth);
  }

  @Get('assets/:id')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get pets in an asset',
    description: 'Retrieve pet sightings and recognized pet identities in an asset.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getAssetPets(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetPetResponseDto[]> {
    return this.service.getAssetPets(auth, id);
  }

  @Get('assets/:id/tracks/:trackId/suggestions')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get pet suggestions for a video track',
    description: 'Retrieve the closest pet identities for one detected video track.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getTrackSuggestions(@Auth() auth: AuthDto, @Param() { id, trackId }: PetTrackParamsDto): Promise<PetSuggestionDto[]> {
    return this.service.getTrackSuggestions(auth, id, trackId);
  }

  @Post('assignments')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Assign pet video tracks',
    description:
      'Assign, unassign, reject, restore, or correct the species of exact pet tracks without changing other tracks in the asset.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  assignTracks(@Auth() auth: AuthDto, @Body() dto: PetTrackAssignmentDto): Promise<AssetPetResponseDto[]> {
    return this.service.assignTracks(auth, dto);
  }

  @Get('assets/:id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get a pet sighting thumbnail',
    description: 'Retrieve the analyzed video frame for a specific pet sighting.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getPetSightingThumbnail(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() response: Response) {
    const thumbnail = await this.service.getSightingThumbnail(auth, id);
    response.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400, no-transform',
    });
    response.send(thumbnail);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get a pet thumbnail',
    description: 'Retrieve the analyzed video frame used as the feature image for a pet.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  async getPetThumbnail(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Res() response: Response) {
    const thumbnail = await this.service.getThumbnail(auth, id);
    response.set({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=86400, no-transform',
    });
    response.send(thumbnail);
  }

  @Delete('assets/:id/identity')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a pet sighting assignment',
    description: 'Remove the current user’s pet identity from one detected pet region without deleting the detection.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  unassignAssetPet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.unassignAssetPet(auth, id);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get a pet',
    description: 'Retrieve a pet owned by the current user.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getPet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PetResponseDto> {
    return this.service.getById(auth, id);
  }

  @Post('assets')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Create a pet sighting',
    description: 'Manually annotate a pet region and assign it to a new or existing pet identity.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  createAssetPet(@Auth() auth: AuthDto, @Body() dto: AssetPetCreateDto): Promise<AssetPetResponseDto> {
    return this.service.createAssetPet(auth, dto);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update a pet',
    description: 'Update the name or visibility of a recognized pet.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  updatePet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: PetUpdateDto): Promise<PetResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Post(':id/merge')
  @Authenticated({ permission: Permission.PersonMerge })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge pets',
    description: 'Merge a list of pet identities into the pet specified in the path parameter.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  mergePets(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: PetMergeDto): Promise<PetResponseDto> {
    return this.service.merge(auth, id, dto);
  }

  @Post(':id/reassign')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Reassign pet sightings',
    description: 'Move selected pet sightings to an existing or newly created pet identity.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  reassignPetSightings(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PetReassignDto,
  ): Promise<PetResponseDto> {
    return this.service.reassign(auth, id, dto);
  }

  @Post(':id/reject-appearances')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Reject pet appearances',
    description:
      'Mark appearances of the specified pet in selected assets as false detections so pet recognition will not recreate them.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  rejectPetAppearances(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PetRejectAppearancesDto,
  ): Promise<PetRejectAppearancesResponseDto> {
    return this.service.rejectAppearances(auth, id, dto);
  }

  @Post('recognition')
  @Authenticated({ permission: Permission.QueueUpdate, admin: true })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Run pet recognition',
    description: 'Queue missing or forced pet detection and recognition for the library.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  runPetRecognition(@Auth() auth: AuthDto, @Body() dto: PetRecognitionRunDto): Promise<void> {
    return this.service.runRecognition(auth, dto);
  }
}
