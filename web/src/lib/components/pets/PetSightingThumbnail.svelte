<script lang="ts">
  import type { AssetPetResponseDto } from '@immich/sdk';

  type Props = {
    sighting: AssetPetResponseDto;
    name: string;
    imageUrl?: string;
    class?: string;
  };

  let { sighting, name, imageUrl, class: className = '' }: Props = $props();
  const width = $derived(Math.max(1, sighting.boundingBoxX2 - sighting.boundingBoxX1));
  const height = $derived(Math.max(1, sighting.boundingBoxY2 - sighting.boundingBoxY1));
  const sourceUrl = $derived(imageUrl ?? `/api/pets/assets/${sighting.id}/thumbnail`);
</script>

<div class="overflow-hidden bg-gray-200 dark:bg-gray-700 {className}">
  <svg
    class="size-full"
    viewBox={`${sighting.boundingBoxX1} ${sighting.boundingBoxY1} ${width} ${height}`}
    role="img"
    aria-label={name}
  >
    <image
      href={sourceUrl}
      width={sighting.imageWidth}
      height={sighting.imageHeight}
      preserveAspectRatio="xMidYMid slice"
    />
  </svg>
</div>
