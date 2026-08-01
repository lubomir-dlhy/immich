<script lang="ts">
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { reassignPetSightings, type PetResponseDto } from '@immich/sdk';
  import { FormModal, Icon, toastManager } from '@immich/ui';
  import { mdiImageMove, mdiPawOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    source: PetResponseDto;
    candidates: PetResponseDto[];
    assetIds: string[];
    onClose: (pet?: PetResponseDto) => void;
  };

  let { source, candidates, assetIds, onClose }: Props = $props();
  let targetId = $state<string>();
  const target = $derived(candidates.find(({ id }) => id === targetId));

  const onSubmit = async () => {
    try {
      const reassigned = await reassignPetSightings({
        id: source.id,
        petReassignDto: { assetIds, targetPetId: target?.id },
      });
      toastManager.primary($t('pet_photos_reassigned', { values: { count: assetIds.length } }));
      onClose(reassigned);
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };
</script>

<FormModal title={$t('reassign_pet_photos')} submitColor="primary" submitText={$t('reassign')} {onClose} {onSubmit}>
  <p class="mb-5 text-sm text-gray-500 dark:text-gray-300">
    {$t('reassign_pet_photos_description', { values: { count: assetIds.length } })}
  </p>

  <div class="flex items-center justify-center gap-5">
    <div class="w-28 text-center">
      <PetThumbnail pet={source} class="aspect-square rounded-full shadow-md" />
      <p class="mt-2 truncate font-medium">{source.name || $t('unrecognized_pet')}</p>
    </div>

    <Icon icon={mdiImageMove} size="38" class="text-gray-500 dark:text-gray-300" />

    {#if target}
      <div class="w-28 text-center">
        <PetThumbnail pet={target} class="aspect-square rounded-full shadow-md ring-2 ring-immich-primary" />
        <p class="mt-2 truncate font-medium">{target.name || $t('unrecognized_pet')}</p>
      </div>
    {:else}
      <div class="flex w-28 flex-col items-center text-center">
        <div
          class="flex aspect-square w-full items-center justify-center rounded-full bg-primary/10 text-primary ring-2 ring-immich-primary dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary"
        >
          <Icon icon={mdiPawOutline} size="54" />
        </div>
        <p class="mt-2 truncate font-medium">{$t('create_new_pet')}</p>
      </div>
    {/if}
  </div>

  <div class="mt-6 grid max-h-56 grid-cols-3 gap-3 overflow-y-auto p-1 sm:grid-cols-4">
    <button
      type="button"
      class="min-w-0 rounded-xl p-1.5 transition-colors outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-immich-primary dark:hover:bg-gray-800"
      class:bg-gray-100={!targetId}
      class:dark:bg-gray-800={!targetId}
      onclick={() => (targetId = undefined)}
    >
      <div
        class="flex aspect-square items-center justify-center rounded-full bg-primary/10 text-primary dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary"
      >
        <Icon icon={mdiPawOutline} size="42" />
      </div>
      <p class="mt-1 truncate text-xs">{$t('create_new_pet')}</p>
    </button>

    {#each candidates as pet (pet.id)}
      <button
        type="button"
        class="min-w-0 rounded-xl p-1.5 transition-colors outline-none hover:bg-gray-100 focus-visible:ring-2 focus-visible:ring-immich-primary dark:hover:bg-gray-800"
        class:bg-gray-100={pet.id === targetId}
        class:dark:bg-gray-800={pet.id === targetId}
        onclick={() => (targetId = pet.id)}
      >
        <PetThumbnail {pet} class="aspect-square rounded-full shadow-sm" />
        <p class="mt-1 truncate text-xs">{pet.name || $t('unrecognized_pet')}</p>
      </button>
    {/each}
  </div>
</FormModal>
