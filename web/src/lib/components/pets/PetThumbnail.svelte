<script lang="ts">
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type PetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiPaw } from '@mdi/js';

  type Props = {
    pet: PetResponseDto;
    class?: string;
  };

  let { pet, class: className = '' }: Props = $props();
  const hasThumbnail = $derived(
    pet.featureAssetId &&
      pet.imageWidth &&
      pet.imageHeight &&
      pet.boundingBoxX1 !== undefined &&
      pet.boundingBoxY1 !== undefined &&
      pet.boundingBoxX2 !== undefined &&
      pet.boundingBoxY2 !== undefined,
  );
</script>

<div class="overflow-hidden bg-gray-100 dark:bg-gray-800 {className}">
  {#if hasThumbnail}
    <svg
      class="size-full"
      viewBox={`${pet.boundingBoxX1} ${pet.boundingBoxY1} ${Math.max(1, pet.boundingBoxX2! - pet.boundingBoxX1!)} ${Math.max(1, pet.boundingBoxY2! - pet.boundingBoxY1!)}`}
      role="img"
      aria-label={pet.name}
    >
      <image
        href={pet.featureIsVideo
          ? `/api/pets/${pet.id}/thumbnail?feature=${pet.featurePetAssetId}`
          : getAssetMediaUrl({ id: pet.featureAssetId!, size: AssetMediaSize.Preview })}
        width={pet.imageWidth}
        height={pet.imageHeight}
        preserveAspectRatio="xMidYMid slice"
      />
    </svg>
  {:else}
    <div class="flex size-full items-center justify-center">
      <Icon icon={mdiPaw} size="64" class="text-gray-400 dark:text-gray-500" />
    </div>
  {/if}
</div>
