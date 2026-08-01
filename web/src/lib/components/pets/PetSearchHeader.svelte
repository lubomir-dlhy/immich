<script lang="ts">
  import { goto } from '$app/navigation';
  import PetMergeModal from '$lib/modals/PetMergeModal.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { getPet, getPets, Species, updatePet, type PetResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner, modalManager } from '@immich/ui';
  import { mdiCallMerge, mdiPaw, mdiViewGridOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import PetThumbnail from './PetThumbnail.svelte';

  type Props = {
    petId: string;
    petPromise?: Promise<PetResponseDto>;
  };

  let { petId, petPromise }: Props = $props();
  let pet = $state<PetResponseDto>();
  let draftName = $state('');
  let loading = $state(true);
  let saving = $state(false);

  onMount(async () => {
    try {
      pet = await (petPromise ?? getPet({ id: petId }));
      draftName = pet.name;
    } catch (error) {
      handleError(error, $t('failed_to_load_pets'));
    } finally {
      loading = false;
    }
  });

  const save = async (updates: { name?: string; species?: Species }) => {
    if (!pet || saving) {
      return;
    }

    saving = true;
    try {
      const updated = await updatePet({ id: pet.id, petUpdateDto: updates });
      pet = { ...pet, ...updated };
      draftName = pet.name;
    } catch (error) {
      draftName = pet.name;
      handleError(error, $t('failed_to_update_pet'));
    } finally {
      saving = false;
    }
  };

  const saveName = async () => {
    const name = draftName.trim();
    if (!pet || name === pet.name) {
      return;
    }
    await save({ name });
  };

  const merge = async () => {
    if (!pet) {
      return;
    }

    try {
      const pets = await getPets();
      const merged = await modalManager.show(PetMergeModal, {
        source: pet,
        candidates: pets.filter(
          (candidate) => candidate.id !== pet?.id && candidate.species === pet?.species && !candidate.isHidden,
        ),
      });
      if (merged) {
        await goto(Route.viewPet(merged, { previousRoute: Route.pets() }));
      }
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };
</script>

<div
  class="mx-auto mt-4 flex min-h-16 w-full max-w-3xl items-center gap-3 rounded-2xl border border-gray-200 bg-white/90 px-3 py-2 shadow-sm backdrop-blur-sm dark:border-gray-700 dark:bg-immich-dark-gray/90"
>
  {#if loading}
    <div class="flex w-full justify-center py-1">
      <LoadingSpinner size="small" />
    </div>
  {:else if pet}
    <PetThumbnail {pet} class="size-12 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/10" />

    <div class="min-w-0 flex-1">
      <form
        onsubmit={(event) => {
          event.preventDefault();
          void saveName();
        }}
      >
        <input
          type="text"
          class="w-full truncate border-0 bg-transparent p-0 text-sm font-semibold text-immich-fg outline-none placeholder:text-gray-400 focus:ring-0 disabled:opacity-60 dark:text-immich-dark-fg"
          aria-label={$t('pet_name')}
          placeholder={$t('add_a_name')}
          disabled={saving}
          bind:value={draftName}
          onblur={() => void saveName()}
        />
      </form>
      <div class="mt-0.5 flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
        <select
          class="cursor-pointer appearance-none border-0 bg-transparent p-0 text-xs text-gray-500 capitalize outline-none focus:ring-2 focus:ring-immich-primary/40 disabled:cursor-wait disabled:opacity-60 dark:text-gray-400"
          aria-label={$t('pet_category')}
          value={pet.species}
          disabled={saving}
          onchange={(event) => void save({ species: event.currentTarget.value as Species })}
        >
          <option value={Species.Cat}>{$t('pet_category_cat')}</option>
          <option value={Species.Dog}>{$t('pet_category_dog')}</option>
        </select>
        <span aria-hidden="true">·</span>
        <span>{$t('items_count', { values: { count: pet.assetCount ?? 0 } })}</span>
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="flex size-10 items-center justify-center rounded-full text-gray-600 outline-offset-2 transition-colors hover:bg-gray-100 hover:text-immich-primary focus-visible:outline-2 focus-visible:outline-immich-primary dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-immich-dark-primary"
        aria-label={$t('merge_pets')}
        title={$t('merge_pets')}
        onclick={() => void merge()}
      >
        <Icon icon={mdiCallMerge} size="20" />
      </button>
      <a
        href={Route.pets()}
        class="flex h-10 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-gray-600 outline-offset-2 transition-colors hover:bg-gray-100 hover:text-immich-primary focus-visible:outline-2 focus-visible:outline-immich-primary dark:text-gray-300 dark:hover:bg-gray-700 dark:hover:text-immich-dark-primary"
        aria-label={$t('pets')}
      >
        <Icon icon={mdiViewGridOutline} size="18" />
        <span class="hidden sm:inline">{$t('pets')}</span>
      </a>
    </div>
  {:else}
    <div class="flex w-full items-center justify-center gap-2 py-1 text-sm text-gray-500 dark:text-gray-400">
      <Icon icon={mdiPaw} size="20" />
      <span>{$t('unrecognized_pet')}</span>
    </div>
  {/if}
</div>
