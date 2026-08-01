<script lang="ts">
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import type { AssetPetResponseDto } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    assetId: string;
    petId: string;
    isVideo?: boolean;
    selected?: boolean;
  };

  let { assetId, petId, isVideo = false, selected = false }: Props = $props();
  let rootElement: HTMLDivElement | undefined = $state();
  let active = $state(false);
  let currentTimeMs = $state(0);
  let hasVideoTime = $state(false);
  let sightings: AssetPetResponseDto[] | undefined = $state();
  let requestId = 0;

  const matchingSightings = $derived(
    sightings?.filter(
      (sighting) => sighting.pet?.id === petId && sighting.imageWidth > 0 && sighting.imageHeight > 0,
    ) ?? [],
  );
  const visibleSightings = $derived(
    isVideo
      ? hasVideoTime
        ? matchingSightings.filter(
            ({ frameTimestampMs, frameDurationMs }) =>
              currentTimeMs >= frameTimestampMs &&
              (frameDurationMs === null || currentTimeMs < frameTimestampMs + frameDurationMs),
          )
        : []
      : matchingSightings,
  );
  const referenceSighting = $derived(visibleSightings[0]);
  const displayName = $derived(matchingSightings[0]?.pet?.name || $t('unrecognized_pet'));
  const maskId = $derived(`pet-search-focus-${assetId}`);

  const load = async () => {
    const currentRequestId = ++requestId;
    try {
      const result = await assetCacheManager.getAssetPets(assetId);
      if (currentRequestId === requestId) {
        sightings = result;
      }
    } catch {
      if (currentRequestId === requestId) {
        sightings = [];
      }
    }
  };

  onMount(() => {
    const tile = rootElement?.parentElement;
    if (!tile) {
      return;
    }

    const activate = () => {
      active = true;
      if (!sightings) {
        void load();
      }
    };
    const deactivate = () => {
      active = false;
      currentTimeMs = 0;
      hasVideoTime = false;
    };
    const handleVideoTimeUpdate = (event: Event) => {
      currentTimeMs = (event as CustomEvent<{ currentTimeMs: number }>).detail.currentTimeMs;
      hasVideoTime = true;
    };
    const handleFocusOut = (event: FocusEvent) => {
      if (!tile.contains(event.relatedTarget as Node | null)) {
        deactivate();
      }
    };

    tile.addEventListener('pointerenter', activate);
    tile.addEventListener('pointerleave', deactivate);
    tile.addEventListener('focusin', activate);
    tile.addEventListener('focusout', handleFocusOut);
    tile.addEventListener('immich:thumbnail-video-timeupdate', handleVideoTimeUpdate);

    return () => {
      tile.removeEventListener('pointerenter', activate);
      tile.removeEventListener('pointerleave', deactivate);
      tile.removeEventListener('focusin', activate);
      tile.removeEventListener('focusout', handleFocusOut);
      tile.removeEventListener('immich:thumbnail-video-timeupdate', handleVideoTimeUpdate);
    };
  });
</script>

<div
  bind:this={rootElement}
  class={[
    'pointer-events-none absolute inset-0 z-1 overflow-hidden transition-transform',
    { 'scale-[0.85] rounded-xl': selected },
  ]}
  aria-hidden="true"
>
  {#if active && referenceSighting}
    <svg
      class="absolute size-full"
      viewBox={`0 0 ${referenceSighting.imageWidth} ${referenceSighting.imageHeight}`}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width={referenceSighting.imageWidth}
          height={referenceSighting.imageHeight}
        >
          <rect width="100%" height="100%" fill="white" />
          {#each visibleSightings as sighting (sighting.id)}
            <rect
              x={sighting.boundingBoxX1}
              y={sighting.boundingBoxY1}
              width={Math.max(1, sighting.boundingBoxX2 - sighting.boundingBoxX1)}
              height={Math.max(1, sighting.boundingBoxY2 - sighting.boundingBoxY1)}
              rx="10"
              fill="black"
            />
          {/each}
        </mask>
      </defs>

      <rect
        width="100%"
        height="100%"
        fill="black"
        fill-opacity="0.58"
        mask={`url(#${maskId})`}
        class="animate-in fade-in duration-150"
      />
      {#each visibleSightings as sighting (sighting.id)}
        <rect
          x={sighting.boundingBoxX1}
          y={sighting.boundingBoxY1}
          width={Math.max(1, sighting.boundingBoxX2 - sighting.boundingBoxX1)}
          height={Math.max(1, sighting.boundingBoxY2 - sighting.boundingBoxY1)}
          rx="10"
          fill="none"
          stroke="var(--color-immich-primary)"
          stroke-width="3"
          vector-effect="non-scaling-stroke"
          class="dark:stroke-immich-dark-primary"
        />
      {/each}
    </svg>

    <div class="absolute inset-x-2 bottom-2 flex justify-center">
      <span
        class="max-w-full truncate rounded-full bg-black/75 px-3 py-1 text-xs font-medium text-white shadow-lg ring-1 ring-white/20 backdrop-blur-sm"
      >
        {displayName}
      </span>
    </div>
  {/if}
</div>
