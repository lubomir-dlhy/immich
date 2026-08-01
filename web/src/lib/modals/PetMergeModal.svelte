<script lang="ts">
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { mergePets, type PetResponseDto } from '@immich/sdk';
  import { FormModal, Icon, toastManager } from '@immich/ui';
  import { mdiCallMerge } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    source: PetResponseDto;
    candidates: PetResponseDto[];
    onClose: (pet?: PetResponseDto) => void;
  };

  let { source, candidates, onClose }: Props = $props();
  let targetId = $state(candidates[0]?.id ?? '');
  const target = $derived(candidates.find(({ id }) => id === targetId));

  const onSubmit = async () => {
    if (!target) {
      return;
    }

    try {
      const merged = await mergePets({ id: target.id, petMergeDto: { ids: [source.id] } });
      toastManager.primary($t('merge_pets_successfully'));
      onClose(merged);
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };
</script>

<FormModal
  title={$t('merge_pets')}
  submitColor="primary"
  submitText={$t('merge')}
  disabled={!target}
  {onClose}
  {onSubmit}
>
  <p class="mb-4 text-sm text-gray-500 dark:text-gray-300">{$t('select_pet_to_merge')}</p>

  <div class="flex items-center justify-center gap-5">
    <div class="w-28 text-center">
      <PetThumbnail pet={source} class="aspect-square rounded-full shadow-md" />
      <p class="mt-2 truncate font-medium">{source.name || $t('unrecognized_pet')}</p>
    </div>

    <Icon icon={mdiCallMerge} size="42" class="rotate-90 text-gray-500 dark:text-gray-300" />

    {#if target}
      <div class="w-32 text-center">
        <PetThumbnail pet={target} class="aspect-square rounded-full shadow-md ring-2 ring-immich-primary" />
        <p class="mt-2 truncate font-medium">{target.name || $t('unrecognized_pet')}</p>
      </div>
    {/if}
  </div>

  <div class="mt-6 grid max-h-56 grid-cols-3 gap-3 overflow-y-auto p-1 sm:grid-cols-4">
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
