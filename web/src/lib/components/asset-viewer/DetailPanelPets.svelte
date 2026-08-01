<script lang="ts">
  import { goto } from '$app/navigation';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import PetSightingThumbnail from '$lib/components/pets/PetSightingThumbnail.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import PetMergeModal from '$lib/modals/PetMergeModal.svelte';
  import PetTrackAssignmentModal from '$lib/modals/PetTrackAssignmentModal.svelte';
  import { Route } from '$lib/route';
  import { petManager } from '$lib/stores/pet.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    assignTracks,
    getPets,
    Species,
    type AssetPetResponseDto,
    type AssetResponseDto,
    unassignAssetPet,
  } from '@immich/sdk';
  import { Icon, IconButton, LoadingSpinner, modalManager, Text, toastManager } from '@immich/ui';
  import {
    mdiCallMerge,
    mdiCat,
    mdiDog,
    mdiDotsVertical,
    mdiEye,
    mdiEyeOff,
    mdiImageMultipleOutline,
    mdiPawOutline,
    mdiPlus,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
  };

  let { asset, isOwner }: Props = $props();
  let videoTimeMs = 0;
  let showAllTracks = $state(false);
  let selectedVideoSummaryId = $state<string>();
  let videoTimeFrame: number | undefined;
  let rootElement = $state.raw<HTMLElement>();
  const sightings = $derived(petManager.data);
  const loading = $derived(petManager.loading);
  const onPetAssignmentsUpdate = async ({ assetIds }: { assetIds: string[] }) => {
    if (!assetIds.includes(asset.id)) {
      return;
    }
    petManager.invalidate();
    await petManager.getAssetPets(asset.id);
  };
  const unhiddenSightings = $derived(
    sightings.filter((sighting) => assetViewerManager.isShowingHiddenPets || !sighting.pet?.isHidden),
  );
  const getActiveSightings = () =>
    unhiddenSightings.filter(
      ({ frameTimestampMs, frameDurationMs }) =>
        videoTimeMs >= frameTimestampMs &&
        (frameDurationMs === null || videoTimeMs < frameTimestampMs + frameDurationMs),
    );
  const videoPetSummaries = $derived.by(() => {
    const summaries: Array<{
      id: string;
      name: string;
      species: string;
      petId?: string;
      representative: AssetPetResponseDto;
      trackIds: Set<string>;
      sightings: AssetPetResponseDto[];
      startMs: number;
      endMs: number;
    }> = [];

    for (const sighting of unhiddenSightings) {
      const id = sighting.pet?.id ?? sighting.trackId;
      const existing = summaries.find((summary) => summary.id === id);
      const endMs = sighting.frameTimestampMs + (sighting.frameDurationMs ?? 1);
      if (existing) {
        existing.sightings.push(sighting);
        existing.trackIds.add(sighting.trackId);
        existing.startMs = Math.min(existing.startMs, sighting.frameTimestampMs);
        existing.endMs = Math.max(existing.endMs, endMs);
      } else {
        summaries.push({
          id,
          name: sighting.pet?.name || $t('unrecognized_pet'),
          species: sighting.species,
          petId: sighting.pet?.id,
          representative: sighting,
          trackIds: new Set([sighting.trackId]),
          sightings: [sighting],
          startMs: sighting.frameTimestampMs,
          endMs,
        });
      }
    }

    return summaries.sort(
      (left, right) =>
        Number(Boolean(right.representative.pet?.name)) - Number(Boolean(left.representative.pet?.name)) ||
        left.startMs - right.startMs,
    );
  });
  const displayedVideoPetSummaries = $derived(showAllTracks ? videoPetSummaries : videoPetSummaries.slice(0, 3));

  const thumbnailUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }),
  );

  const formatVideoTime = (milliseconds: number) => {
    const seconds = Math.max(0, Math.floor(milliseconds / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };

  const getSummarySighting = (summary: (typeof videoPetSummaries)[number]) =>
    getActiveSightings().find((sighting) => summary.trackIds.has(sighting.trackId)) ?? summary.representative;

  const highlightVideoSummary = (summary: (typeof videoPetSummaries)[number]) => {
    const sighting = getActiveSightings().find((candidate) => summary.trackIds.has(candidate.trackId));
    if (sighting) {
      assetViewerManager.setHighlightedFaces([{ ...sighting, name: summary.name }]);
    } else {
      assetViewerManager.clearHighlightedFaces();
    }
  };

  const focusVideoSighting = (summary: (typeof videoPetSummaries)[number], sighting: AssetPetResponseDto) => {
    selectedVideoSummaryId = summary.id;
    assetViewerManager.focusVideo(sighting.frameTimestampMs / 1000);
    assetViewerManager.setHighlightedFaces([{ ...sighting, name: summary.name }]);
  };

  const focusVideoSummary = (summary: (typeof videoPetSummaries)[number]) =>
    focusVideoSighting(summary, getSummarySighting(summary));

  const restoreSelectedVideoSighting = () => {
    const summary = videoPetSummaries.find(({ id }) => id === selectedVideoSummaryId);
    const sighting = summary
      ? getActiveSightings().find((candidate) => summary.trackIds.has(candidate.trackId))
      : undefined;
    if (summary && sighting) {
      assetViewerManager.setHighlightedFaces([{ ...sighting, name: summary.name }]);
    } else {
      assetViewerManager.clearHighlightedFaces();
    }
  };

  const focusNextUnrecognizedPet = async () => {
    await tick();
    const next = videoPetSummaries.find(({ representative }) => !representative.pet?.name);
    if (next) {
      focusVideoSummary(next);
    } else {
      assetViewerManager.clearHighlightedFaces();
    }
  };

  const editVideoSummary = async (summary: (typeof videoPetSummaries)[number]) => {
    const sighting = getSummarySighting(summary);
    focusVideoSighting(summary, sighting);
    const updated = await modalManager.show(PetTrackAssignmentModal, {
      assetId: asset.id,
      sighting,
      trackIds: [...summary.trackIds],
      name: summary.name,
      timeLabel: `${formatVideoTime(sighting.frameTimestampMs)}–${formatVideoTime(
        sighting.frameTimestampMs + (sighting.frameDurationMs ?? 1),
      )}`,
      canReject: isOwner,
    });
    if (updated) {
      await focusNextUnrecognizedPet();
    }
  };

  const editPhotoSighting = async (sighting: AssetPetResponseDto) => {
    const displayName = sighting.pet?.name || $t('unrecognized_pet');
    assetViewerManager.setHighlightedFaces([{ ...sighting, name: displayName }]);
    await modalManager.show(PetTrackAssignmentModal, {
      assetId: asset.id,
      sighting,
      trackIds: [sighting.trackId],
      name: displayName,
      timeLabel: $t('image'),
      imageUrl: thumbnailUrl,
      canReject: isOwner,
    });
  };

  const changePhotoSpecies = async (sighting: AssetPetResponseDto, species: Species) => {
    try {
      await assignTracks({
        petTrackAssignmentDto: {
          selectors: [{ assetId: asset.id, trackId: sighting.trackId }],
          target: { type: 'species', species },
        },
      });
      assetViewerManager.clearHighlightedFaces();
      petManager.invalidate();
      await petManager.getAssetPets(asset.id);
      eventManager.emit('PetAssignmentsUpdate', { assetIds: [asset.id] });
      toastManager.primary({
        description: $t('pet_species_updated', {
          values: { species: species === Species.Dog ? $t('pet_category_dog') : $t('pet_category_cat') },
        }),
      });
    } catch (error) {
      handleError(error, $t('pet_assignment_failed'));
    }
  };

  const removeVideoTrack = async (summary: (typeof videoPetSummaries)[number]) => {
    const sighting = getSummarySighting(summary);
    const selectors = [{ assetId: asset.id, trackId: sighting.trackId }];
    try {
      await assignTracks({ petTrackAssignmentDto: { selectors, target: { type: 'rejected' } } });
      petManager.invalidate();
      await petManager.getAssetPets(asset.id);
      toastManager.primary({
        description: $t('pet_track_removed'),
        button: {
          label: $t('undo'),
          onclick: async () => {
            try {
              await assignTracks({ petTrackAssignmentDto: { selectors, target: { type: 'restore' } } });
              petManager.invalidate();
              await petManager.getAssetPets(asset.id);
            } catch (error) {
              handleError(error, $t('pet_assignment_failed'));
            }
          },
        },
      });
      await focusNextUnrecognizedPet();
    } catch (error) {
      handleError(error, $t('pet_assignment_failed'));
    }
  };

  const mergeVideoPet = async (summary: (typeof videoPetSummaries)[number]) => {
    const source = summary.representative.pet;
    if (!source) {
      return;
    }

    try {
      const pets = await getPets();
      const merged = await modalManager.show(PetMergeModal, {
        source,
        candidates: pets.filter((pet) => pet.id !== source.id && pet.species === source.species && !pet.isHidden),
      });
      if (merged) {
        petManager.invalidate();
        await petManager.getAssetPets(asset.id);
        eventManager.emit('PetAssignmentsUpdate', { assetIds: [asset.id] });
      }
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const mergePhotoPet = async (sighting: AssetPetResponseDto) => {
    const source = sighting.pet;
    if (!source) {
      return;
    }

    try {
      const pets = await getPets();
      const merged = await modalManager.show(PetMergeModal, {
        source,
        candidates: pets.filter((pet) => pet.id !== source.id && pet.species === source.species && !pet.isHidden),
      });
      if (merged) {
        petManager.invalidate();
        await petManager.getAssetPets(asset.id);
        eventManager.emit('PetAssignmentsUpdate', { assetIds: [asset.id] });
      }
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const updateActiveVideoSummaries = (milliseconds: number) => {
    videoTimeMs = milliseconds;
    const activeSummaryIds = new Set(getActiveSightings().map((sighting) => sighting.pet?.id ?? sighting.trackId));

    for (const element of rootElement?.querySelectorAll<HTMLElement>('[data-video-pet-summary]') ?? []) {
      element.dataset.active = String(activeSummaryIds.has(element.dataset.videoPetSummary ?? ''));
    }

    const selectedSummary = videoPetSummaries.find(({ id }) => id === selectedVideoSummaryId);
    const activeSelectedSighting = selectedSummary
      ? getActiveSightings().find((sighting) => selectedSummary.trackIds.has(sighting.trackId))
      : undefined;
    if (selectedSummary) {
      if (activeSelectedSighting) {
        assetViewerManager.setHighlightedFaces([{ ...activeSelectedSighting, name: selectedSummary.name }]);
      } else {
        assetViewerManager.clearHighlightedFaces();
      }
    }
  };

  onMount(() => {
    const unsubscribe = assetViewerManager.on({
      VideoTimeChange: (milliseconds) => {
        cancelAnimationFrame(videoTimeFrame ?? 0);
        videoTimeFrame = requestAnimationFrame(() => updateActiveVideoSummaries(milliseconds));
      },
    });

    return () => {
      cancelAnimationFrame(videoTimeFrame ?? 0);
      unsubscribe();
    };
  });

  const removeAssignment = async (sighting: AssetPetResponseDto) => {
    if (!isOwner && !sighting.pet) {
      return;
    }

    const confirmed = await modalManager.showDialog({
      prompt: $t('confirm_remove_pet_annotation', {
        values: { name: sighting.pet?.name || $t('unrecognized_pet') },
      }),
    });
    if (!confirmed) {
      return;
    }

    try {
      if (isOwner) {
        const selectors = [{ assetId: asset.id, trackId: sighting.trackId }];
        await assignTracks({ petTrackAssignmentDto: { selectors, target: { type: 'rejected' } } });
        toastManager.primary({
          description: $t('pet_track_removed'),
          button: {
            label: $t('undo'),
            onclick: async () => {
              try {
                await assignTracks({ petTrackAssignmentDto: { selectors, target: { type: 'restore' } } });
                petManager.invalidate();
                await petManager.getAssetPets(asset.id);
              } catch (error) {
                handleError(error, $t('pet_assignment_failed'));
              }
            },
          },
        });
      } else {
        await unassignAssetPet({ id: sighting.id });
      }
      assetViewerManager.clearHighlightedFaces();
      petManager.invalidate();
      await petManager.getAssetPets(asset.id);
      eventManager.emit('PetAssignmentsUpdate', { assetIds: [asset.id] });
    } catch (error) {
      handleError(error, $t('failed_to_remove_pet_annotation'));
    }
  };
</script>

<OnEvents {onPetAssignmentsUpdate} />

{#if isOwner || loading || unhiddenSightings.length > 0}
  <section class="px-4 pt-4 text-sm" bind:this={rootElement}>
    <div class="flex h-10 w-full items-center justify-between">
      <Text size="small" color="muted">{$t('pets')}</Text>
      {#if loading}
        <LoadingSpinner size="large" />
      {:else if isOwner}
        <div class="flex items-center gap-2">
          {#if sightings.some((sighting) => sighting.pet?.isHidden)}
            <IconButton
              aria-label={assetViewerManager.isShowingHiddenPets ? $t('hide_hidden_pets') : $t('show_hidden_pets')}
              icon={assetViewerManager.isShowingHiddenPets ? mdiEyeOff : mdiEye}
              size="medium"
              shape="round"
              color="secondary"
              variant="ghost"
              onclick={() => assetViewerManager.toggleHiddenPets()}
            />
          {/if}
          <IconButton
            aria-label={$t('annotate_pet')}
            icon={mdiPlus}
            size="medium"
            shape="round"
            color="secondary"
            variant="ghost"
            onclick={() => assetViewerManager.togglePetEditMode()}
          />
        </div>
      {/if}
    </div>

    {#if asset.type === AssetTypeEnum.Video}
      {#if videoPetSummaries.length > 0}
        <div class="mt-2 space-y-2">
          {#each displayedVideoPetSummaries as summary, index (summary.id)}
            {@const isNamed = Boolean(summary.representative.pet?.name)}
            <div
              role="group"
              class="group flex items-center gap-3 rounded-xl border border-gray-200 px-3 py-2 transition-colors hover:bg-gray-50 data-[selected=true]:border-immich-primary data-[selected=true]:bg-immich-primary/10 data-[selected=true]:ring-2 data-[selected=true]:ring-immich-primary/40 dark:border-gray-700 dark:hover:bg-gray-800 dark:data-[selected=true]:border-immich-dark-primary dark:data-[selected=true]:bg-immich-dark-primary/10 dark:data-[selected=true]:ring-immich-dark-primary/40"
              data-video-pet-summary={summary.id}
              data-active="false"
              data-selected={selectedVideoSummaryId === summary.id}
              onpointerenter={() => highlightVideoSummary(summary)}
              onpointerleave={restoreSelectedVideoSighting}
            >
              <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:ring-2 focus-visible:ring-immich-primary dark:focus-visible:ring-immich-dark-primary"
                aria-label={`${summary.name}, ${formatVideoTime(summary.startMs)}`}
                onclick={() => focusVideoSummary(summary)}
              >
                <span class="relative size-11 shrink-0">
                  <PetSightingThumbnail
                    sighting={summary.representative}
                    name={summary.name}
                    class="size-11 rounded-lg ring-1 ring-black/10"
                  />
                  <span
                    class="absolute -top-1 -left-1 flex size-5 items-center justify-center rounded-full bg-gray-700 text-[10px] font-bold text-white shadow-sm group-data-[active=true]:bg-immich-primary dark:group-data-[active=true]:bg-immich-dark-primary dark:group-data-[active=true]:text-black"
                  >
                    {index + 1}
                  </span>
                </span>
                <span class="min-w-0 flex-1">
                  <span class="block truncate font-medium">{summary.name}</span>
                  <span class="block truncate text-xs text-gray-500 capitalize dark:text-gray-400">
                    {summary.species} · {formatVideoTime(summary.startMs)}–{formatVideoTime(summary.endMs)}
                    {#if summary.trackIds.size > 1}
                      · {$t('pet_appearances', { values: { count: summary.trackIds.size } })}
                    {/if}
                  </span>
                </span>
                <span
                  class="hidden size-2 shrink-0 rounded-full bg-emerald-500 group-data-[active=true]:block"
                  title={$t('present_now')}
                ></span>
              </button>
              <div class="flex shrink-0 items-center gap-1">
                {#if summary.petId}
                  <a
                    class="flex size-8 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-immich-primary focus-visible:ring-2 focus-visible:ring-immich-primary dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-immich-dark-primary"
                    href={Route.search({ petIds: [summary.petId] })}
                    aria-label={`${$t('photos')} ${summary.name}`}
                    title={$t('photos')}
                  >
                    <Icon icon={mdiImageMultipleOutline} size="18" />
                  </a>
                {/if}
                {#if !isNamed}
                  <button
                    type="button"
                    class="rounded-lg bg-immich-primary px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-immich-primary/90 focus-visible:ring-2 focus-visible:ring-immich-primary focus-visible:ring-offset-2 dark:bg-immich-dark-primary dark:text-black"
                    onclick={() => void editVideoSummary(summary)}
                  >
                    {$t('identify_pet')}
                  </button>
                {/if}
                {#if isNamed || summary.petId || isOwner}
                  <ButtonContextMenu
                    icon={mdiDotsVertical}
                    title={$t('menu')}
                    size="small"
                    direction="left"
                    align="top-right"
                  >
                    {#if isNamed}
                      <MenuOption
                        icon={mdiPawOutline}
                        text={$t('change_pet')}
                        onClick={() => void editVideoSummary(summary)}
                      />
                    {/if}
                    {#if summary.representative.pet}
                      <MenuOption
                        icon={mdiCallMerge}
                        text={$t('merge_pets')}
                        onClick={() => void mergeVideoPet(summary)}
                      />
                    {/if}
                    {#if isOwner}
                      <MenuOption
                        icon={mdiTrashCanOutline}
                        text={$t('remove_pet_annotation')}
                        onClick={() => void removeVideoTrack(summary)}
                      />
                    {/if}
                  </ButtonContextMenu>
                {/if}
              </div>
            </div>
          {/each}
        </div>

        <div class="relative mt-3 h-5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
          {#each videoPetSummaries as summary, index (summary.id)}
            {#each [...summary.trackIds] as trackId (trackId)}
              {@const trackSightings = summary.sightings.filter((sighting) => sighting.trackId === trackId)}
              {@const startMs = Math.min(...trackSightings.map(({ frameTimestampMs }) => frameTimestampMs))}
              {@const endMs = Math.max(
                ...trackSightings.map(
                  ({ frameTimestampMs, frameDurationMs }) => frameTimestampMs + (frameDurationMs ?? 1),
                ),
              )}
              {@const firstSighting = trackSightings.find(({ frameTimestampMs }) => frameTimestampMs === startMs)!}
              <button
                type="button"
                class="absolute top-1 h-3 min-w-1 rounded-full transition-all hover:top-0.5 hover:h-4 {index % 3 === 0
                  ? 'bg-immich-primary dark:bg-immich-dark-primary'
                  : index % 3 === 1
                    ? 'bg-amber-500'
                    : 'bg-cyan-500'}"
                style:left={`${(startMs / Math.max(asset.duration ?? 1, 1)) * 100}%`}
                style:width={`${Math.max(((endMs - startMs) / Math.max(asset.duration ?? 1, 1)) * 100, 0.75)}%`}
                aria-label={`${summary.name} at ${formatVideoTime(startMs)}`}
                title={`${summary.name} · ${formatVideoTime(startMs)}`}
                onclick={() => focusVideoSighting(summary, firstSighting)}
              ></button>
            {/each}
          {/each}
        </div>

        {#if videoPetSummaries.length > 3}
          <button
            type="button"
            class="mt-2 text-xs font-medium text-immich-primary hover:underline dark:text-immich-dark-primary"
            onclick={() => (showAllTracks = !showAllTracks)}
          >
            {showAllTracks
              ? $t('show_less')
              : $t('show_more_pets', { values: { count: videoPetSummaries.length - 3 } })}
          </button>
        {/if}
      {/if}
    {:else}
      <div class="mt-2 grid {unhiddenSightings.length <= 6 ? 'grid-cols-3 gap-3' : 'grid-cols-4 gap-2'}">
        {#each unhiddenSightings as sighting (sighting.id)}
          {@const boxWidth = Math.max(1, sighting.boundingBoxX2 - sighting.boundingBoxX1)}
          {@const boxHeight = Math.max(1, sighting.boundingBoxY2 - sighting.boundingBoxY1)}
          {@const displayName = sighting.pet?.name || $t('unrecognized_pet')}
          {@const highlightedRegion = { ...sighting, name: displayName }}
          {@const isHighlighted = assetViewerManager.highlightedFaces.some(({ id }) => id === sighting.id)}
          <div
            class="group relative min-w-0"
            role="group"
            onfocusin={() => assetViewerManager.setHighlightedFaces([highlightedRegion])}
            onfocusout={() => assetViewerManager.clearHighlightedFaces()}
            onpointerenter={() => assetViewerManager.setHighlightedFaces([highlightedRegion])}
            onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
          >
            <a
              class="block min-w-0 outline-none"
              href={sighting.pet ? Route.search({ petIds: [sighting.pet.id] }) : undefined}
              aria-label={displayName}
            >
              <div
                class="aspect-square w-full overflow-hidden rounded-xl bg-gray-200 shadow-md transition-all duration-200 group-focus-within:outline-2 group-focus-within:outline-offset-2 group-focus-within:outline-immich-primary group-hover:scale-[1.015] dark:bg-gray-700 dark:group-focus-within:outline-immich-dark-primary {isHighlighted
                  ? 'ring-2 ring-immich-primary dark:ring-immich-dark-primary'
                  : 'ring-1 ring-black/5'}"
              >
                <svg
                  class="size-full"
                  viewBox={`${sighting.boundingBoxX1} ${sighting.boundingBoxY1} ${boxWidth} ${boxHeight}`}
                  role="img"
                  aria-label={displayName}
                >
                  <image
                    href={thumbnailUrl}
                    width={sighting.imageWidth}
                    height={sighting.imageHeight}
                    preserveAspectRatio="xMidYMid slice"
                  />
                </svg>
              </div>

              <p class="mt-1 truncate font-medium" title={displayName}>
                {displayName}
              </p>
              <p class="truncate text-xs font-light text-gray-500 capitalize dark:text-gray-400">{sighting.species}</p>
            </a>
            <div class="absolute top-1 right-1">
              <ButtonContextMenu
                icon={mdiDotsVertical}
                title={$t('menu')}
                size="small"
                direction="left"
                align="top-right"
              >
                <MenuOption
                  icon={mdiPawOutline}
                  text={sighting.pet?.name ? $t('change_pet') : $t('identify_pet')}
                  onClick={() => void editPhotoSighting(sighting)}
                />
                {#if isOwner}
                  {@const correctedSpecies = sighting.species === Species.Dog ? Species.Cat : Species.Dog}
                  <MenuOption
                    icon={correctedSpecies === Species.Dog ? mdiDog : mdiCat}
                    text={correctedSpecies === Species.Dog ? $t('mark_as_dog') : $t('mark_as_cat')}
                    onClick={() => void changePhotoSpecies(sighting, correctedSpecies)}
                  />
                {/if}
                {#if sighting.pet}
                  <MenuOption
                    icon={mdiCallMerge}
                    text={$t('merge_pets')}
                    onClick={() => void mergePhotoPet(sighting)}
                  />
                  <MenuOption
                    icon={mdiImageMultipleOutline}
                    text={$t('photos')}
                    onClick={() => void goto(Route.search({ petIds: [sighting.pet!.id] }))}
                  />
                {/if}
                {#if isOwner || sighting.pet}
                  <MenuOption
                    icon={mdiTrashCanOutline}
                    text={$t('remove_pet_annotation')}
                    onClick={() => void removeAssignment(sighting)}
                  />
                {/if}
              </ButtonContextMenu>
            </div>
            {#if !sighting.pet?.name}
              <div class="absolute inset-x-1 bottom-11 flex justify-center">
                <button
                  type="button"
                  class="max-w-full truncate rounded-lg bg-black/70 px-2 py-1 text-xs font-semibold text-white shadow-sm backdrop-blur-sm hover:bg-black/80 focus-visible:ring-2 focus-visible:ring-white"
                  onclick={() => void editPhotoSighting(sighting)}
                >
                  {$t('identify_pet')}
                </button>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>
{/if}
