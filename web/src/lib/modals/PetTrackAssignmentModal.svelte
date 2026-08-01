<script lang="ts">
  import PetSightingThumbnail from '$lib/components/pets/PetSightingThumbnail.svelte';
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { petManager } from '$lib/stores/pet.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import {
    assignTracks,
    getPets,
    getTrackSuggestions,
    Species,
    type AssetPetResponseDto,
    type PetResponseDto,
    type PetSuggestionDto,
    type PetTrackAssignmentDto,
  } from '@immich/sdk';
  import { Button, Input, LoadingSpinner, Modal, ModalBody, toastManager } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    assetId: string;
    sighting: AssetPetResponseDto;
    trackIds: string[];
    name: string;
    timeLabel: string;
    imageUrl?: string;
    canReject: boolean;
    onClose: (updated?: boolean) => void;
  };

  let { assetId, sighting, trackIds, name, timeLabel, imageUrl, canReject, onClose }: Props = $props();
  let loading = $state(true);
  let saving = $state(false);
  let creating = $state(false);
  let searchTerm = $state('');
  let newName = $state('');
  let newSpecies = $state(sighting.species === Species.Cat ? Species.Cat : Species.Dog);
  let scope = $state<'track' | 'video'>('track');
  let pets = $state<PetResponseDto[]>([]);
  let suggestions = $state<PetSuggestionDto[]>([]);

  const currentPet = $derived(sighting.pet ?? undefined);
  const selectedTrackIds = $derived(scope === 'video' ? [...new Set(trackIds)] : [sighting.trackId]);
  const suggestionIds = $derived(new Set(suggestions.map(({ pet }) => pet.id)));
  const getMatchPercentage = (distance: number) => Math.round(Math.max(0, Math.min(1, 1 - distance)) * 100);
  const filteredPets = $derived(
    pets
      .filter(({ id, isHidden }) => id !== currentPet?.id && !isHidden && !suggestionIds.has(id))
      .filter((pet) => pet.species === sighting.species)
      .filter((pet) =>
        searchTerm ? normalizeSearchString(pet.name || pet.species).includes(normalizeSearchString(searchTerm)) : true,
      )
      .slice(0, 40),
  );

  onMount(async () => {
    try {
      const [allPets, matches] = await Promise.all([
        getPets(),
        getTrackSuggestions({ id: assetId, trackId: sighting.trackId }),
      ]);
      pets = allPets;
      suggestions = matches.filter(({ pet }) => pet.id !== currentPet?.id);
    } catch (error) {
      handleError(error, $t('pet_assignment_failed'));
    } finally {
      loading = false;
    }
  });

  const refreshPets = async () => {
    petManager.invalidate();
    await petManager.getAssetPets(assetId);
  };

  const applyTarget = async (target: PetTrackAssignmentDto['target'], description: string) => {
    if (saving) {
      return;
    }

    saving = true;
    const selectors = selectedTrackIds.map((trackId) => ({ assetId, trackId }));
    const previousTarget: PetTrackAssignmentDto['target'] =
      target.type === 'rejected'
        ? { type: 'restore' }
        : currentPet
          ? { type: 'existing', petId: currentPet.id }
          : { type: 'unassigned' };

    try {
      await assignTracks({ petTrackAssignmentDto: { selectors, target } });
      await refreshPets();
      eventManager.emit('PetAssignmentsUpdate', { assetIds: [assetId] });
      toastManager.primary({
        description,
        button: {
          label: $t('undo'),
          onclick: async () => {
            try {
              await assignTracks({ petTrackAssignmentDto: { selectors, target: previousTarget } });
              await refreshPets();
              eventManager.emit('PetAssignmentsUpdate', { assetIds: [assetId] });
            } catch (error) {
              handleError(error, $t('pet_assignment_failed'));
            }
          },
        },
      });
      onClose(true);
    } catch (error) {
      handleError(error, $t('pet_assignment_failed'));
    } finally {
      saving = false;
    }
  };

  const assignPet = (pet: PetResponseDto) => applyTarget({ type: 'existing', petId: pet.id }, $t('pet_track_updated'));

  const createPet = () =>
    applyTarget({ type: 'new', species: newSpecies, name: newName.trim() || undefined }, $t('pet_track_updated'));
</script>

<Modal title={currentPet ? $t('change_pet') : $t('identify_pet')} size="small" {onClose}>
  <ModalBody>
    <div class="flex items-center gap-3 rounded-xl bg-gray-100 p-2.5 dark:bg-gray-800">
      <PetSightingThumbnail {sighting} {name} {imageUrl} class="size-14 shrink-0 rounded-lg ring-1 ring-black/10" />
      <div class="min-w-0">
        <p class="truncate text-sm font-semibold">{name}</p>
        <p class="truncate text-xs text-gray-500 capitalize dark:text-gray-400">{sighting.species} · {timeLabel}</p>
      </div>
    </div>

    {#if trackIds.length > 1}
      <div
        class="mt-3 grid grid-cols-2 rounded-lg bg-gray-100 p-1 dark:bg-gray-800"
        aria-label={$t('assignment_scope')}
      >
        <button
          type="button"
          class="rounded-md px-2 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-immich-primary {scope ===
          'track'
            ? 'bg-white text-immich-primary shadow-sm dark:bg-gray-700 dark:text-immich-dark-primary'
            : 'text-gray-500 dark:text-gray-300'}"
          onclick={() => (scope = 'track')}
        >
          {$t('this_clip')}
        </button>
        <button
          type="button"
          class="rounded-md px-2 py-1.5 text-xs font-medium focus-visible:ring-2 focus-visible:ring-immich-primary {scope ===
          'video'
            ? 'bg-white text-immich-primary shadow-sm dark:bg-gray-700 dark:text-immich-dark-primary'
            : 'text-gray-500 dark:text-gray-300'}"
          onclick={() => (scope = 'video')}
        >
          {$t('all_in_video')}
        </button>
      </div>
    {/if}

    {#if loading}
      <div class="flex h-44 items-center justify-center">
        <LoadingSpinner size="large" />
      </div>
    {:else if creating}
      <div class="mt-4 space-y-3">
        <Input
          aria-label={$t('pet_name')}
          name="pet-name"
          autocomplete="off"
          placeholder="{$t('pet_name')}…"
          bind:value={newName}
        />
        <div class="grid grid-cols-2 gap-2">
          <Button
            size="small"
            fullWidth
            variant={newSpecies === Species.Dog ? 'filled' : 'outline'}
            onclick={() => (newSpecies = Species.Dog)}
          >
            {$t('pet_category_dog')}
          </Button>
          <Button
            size="small"
            fullWidth
            variant={newSpecies === Species.Cat ? 'filled' : 'outline'}
            onclick={() => (newSpecies = Species.Cat)}
          >
            {$t('pet_category_cat')}
          </Button>
        </div>
        <div class="grid grid-cols-2 gap-2">
          <Button size="small" fullWidth variant="outline" onclick={() => (creating = false)} disabled={saving}>
            {$t('cancel')}
          </Button>
          <Button size="small" fullWidth onclick={createPet} loading={saving}>
            {$t('create')}
          </Button>
        </div>
      </div>
    {:else}
      {#if suggestions.length > 0}
        <p class="mt-4 mb-2 text-xs font-medium text-gray-500 dark:text-gray-400">{$t('suggestions')}</p>
        <div class="grid grid-cols-3 gap-2">
          {#each suggestions as suggestion (suggestion.pet.id)}
            {@const pet = suggestion.pet}
            {@const matchPercentage = getMatchPercentage(suggestion.distance)}
            <button
              type="button"
              class="relative min-w-0 rounded-xl p-1.5 text-center hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-immich-primary dark:hover:bg-gray-800"
              onclick={() => assignPet(pet)}
              disabled={saving}
              title={$t('match_percentage', { values: { value: matchPercentage } })}
            >
              <PetThumbnail {pet} class="mx-auto aspect-square w-full rounded-lg" />
              <span
                class="absolute top-2 right-2 rounded-full bg-black/75 px-1.5 py-0.5 text-[10px] font-semibold text-white shadow-sm backdrop-blur-sm"
              >
                {matchPercentage}%
              </span>
              <p class="mt-1 truncate text-xs font-medium">{pet.name || $t('unrecognized_pet')}</p>
            </button>
          {/each}
        </div>
      {/if}

      <div class="mt-3">
        <Input
          aria-label={$t('search_pets')}
          name="pet-search"
          autocomplete="off"
          placeholder="{$t('search_pets')}…"
          bind:value={searchTerm}
        />
      </div>

      <div class="mt-2 max-h-48 overflow-y-auto overscroll-contain">
        {#each filteredPets as pet (pet.id)}
          <button
            type="button"
            class="flex w-full min-w-0 items-center gap-2 rounded-lg p-2 text-start hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-immich-primary dark:hover:bg-gray-800"
            onclick={() => assignPet(pet)}
            disabled={saving}
          >
            <PetThumbnail {pet} class="size-9 shrink-0 rounded-full" />
            <span class="min-w-0">
              <span class="block truncate text-sm font-medium">{pet.name || $t('unrecognized_pet')}</span>
              <span class="block truncate text-xs text-gray-500 capitalize dark:text-gray-400">{pet.species}</span>
            </span>
          </button>
        {/each}
      </div>

      <div class="mt-3 grid grid-cols-2 gap-2">
        <Button size="small" fullWidth variant="outline" onclick={() => (creating = true)} disabled={saving}>
          {$t('create_new_pet')}
        </Button>
        {#if canReject}
          <Button
            size="small"
            fullWidth
            color="danger"
            variant="outline"
            onclick={() => applyTarget({ type: 'rejected' }, $t('pet_track_removed'))}
            disabled={saving}
          >
            {$t('not_a_pet')}
          </Button>
        {/if}
      </div>
    {/if}
  </ModalBody>
</Modal>
