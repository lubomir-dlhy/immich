import type { AssetPetResponseDto } from '@immich/sdk';
import { render } from '@testing-library/svelte';
import PetSightingThumbnail from './PetSightingThumbnail.svelte';

const sighting: AssetPetResponseDto = {
  id: 'sighting-id',
  assetId: 'asset-id',
  pet: null,
  species: 'dog',
  trackId: 'track-id',
  imageWidth: 1000,
  imageHeight: 800,
  boundingBoxX1: 100,
  boundingBoxY1: 200,
  boundingBoxX2: 500,
  boundingBoxY2: 600,
  detectionScore: 0.9,
  frameTimestampMs: 0,
  frameDurationMs: null,
};

describe('PetSightingThumbnail', () => {
  it('uses the supplied image preview for still-image sightings', () => {
    const { baseElement } = render(PetSightingThumbnail, {
      sighting,
      name: 'Dog',
      imageUrl: '/api/assets/asset-id/thumbnail?size=preview',
    });

    expect(baseElement.querySelector('image')?.getAttribute('href')).toBe(
      '/api/assets/asset-id/thumbnail?size=preview',
    );
  });

  it('uses the timestamp-aware sighting endpoint by default', () => {
    const { baseElement } = render(PetSightingThumbnail, { sighting, name: 'Dog' });

    expect(baseElement.querySelector('image')?.getAttribute('href')).toBe('/api/pets/assets/sighting-id/thumbnail');
  });
});
