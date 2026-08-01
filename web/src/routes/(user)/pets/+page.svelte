<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import PetMergeModal from '$lib/modals/PetMergeModal.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { type PetResponseDto } from '@immich/sdk';
  import { Icon, IconButton, modalManager } from '@immich/ui';
  import { mdiChartScatterPlot, mdiEye, mdiEyeOff, mdiPawOff } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import PetCard from './PetCard.svelte';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  let pets = $state(data.pets);
  let showHidden = $state(false);
  const petPosition = new Map(data.pets.map((pet, index) => [pet.id, index]));
  let visiblePets = $derived(
    pets
      .filter((pet) => showHidden || !pet.isHidden)
      .sort((left, right) => (petPosition.get(left.id) ?? Infinity) - (petPosition.get(right.id) ?? Infinity)),
  );

  const onPetUpdate = (updatedPet: PetResponseDto) => {
    pets = pets.map((pet) => (pet.id === updatedPet.id ? updatedPet : pet));
  };

  const onPetMerge = async (source: PetResponseDto) => {
    const merged = await modalManager.show(PetMergeModal, {
      source,
      candidates: visiblePets.filter((pet) => pet.id !== source.id && pet.species === source.species),
    });
    if (!merged) {
      return;
    }
    pets = pets.filter(({ id }) => id !== source.id).map((pet) => (pet.id === merged.id ? merged : pet));
  };
</script>

<UserPageLayout
  title={$t('pets')}
  description={visiblePets.length === 0 ? undefined : `(${visiblePets.length.toLocaleString($locale)})`}
>
  {#snippet buttons()}
    <div class="flex items-center justify-end gap-1">
      <a
        href={Route.petClusters()}
        class="flex size-10 items-center justify-center rounded-full text-gray-700 transition-colors hover:bg-gray-200 focus-visible:ring-2 focus-visible:ring-immich-primary dark:text-gray-200 dark:hover:bg-gray-700 dark:focus-visible:ring-immich-dark-primary"
        aria-label={$t('pet_similarity_map')}
        title={$t('pet_similarity_map')}
      >
        <Icon icon={mdiChartScatterPlot} size="22" />
      </a>
      {#if pets.some(({ isHidden }) => isHidden)}
        <IconButton
          icon={showHidden ? mdiEyeOff : mdiEye}
          aria-label={showHidden ? $t('hide_hidden_pets') : $t('show_hidden_pets')}
          size="medium"
          shape="round"
          color="secondary"
          variant="ghost"
          onclick={() => (showHidden = !showHidden)}
        />
      {/if}
    </div>
  {/snippet}

  {#if visiblePets.length > 0}
    <div
      class="grid grid-cols-2 gap-2 pt-2 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] md:gap-4 lg:grid-cols-[repeat(auto-fill,minmax(12rem,1fr))]"
    >
      {#each visiblePets as pet (pet.id)}
        <PetCard {pet} onUpdate={onPetUpdate} onMerge={onPetMerge} />
      {/each}
    </div>
  {:else}
    <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center dark:text-white">
      <div class="flex max-w-lg flex-col items-center px-6 text-center">
        <Icon icon={mdiPawOff} size="3.5em" />
        <p class="mt-5 text-3xl font-medium">{$t('pets_empty')}</p>
        <p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{$t('pets_empty_description')}</p>
      </div>
    </div>
  {/if}
</UserPageLayout>
