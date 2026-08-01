<script lang="ts">
  import { focusOutside } from '$lib/actions/focus-outside';
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { Species, updatePet, type PetResponseDto } from '@immich/sdk';
  import { mdiCallMerge, mdiDotsVertical, mdiEyeOff } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    pet: PetResponseDto;
    onUpdate: (pet: PetResponseDto) => void;
    onMerge: (pet: PetResponseDto) => void;
  };

  let { pet, onUpdate, onMerge }: Props = $props();
  let draftName = $derived(pet.name);
  let saving = $state(false);
  let savingSpecies = $state(false);
  let showOptions = $state(false);

  const saveName = async () => {
    const name = draftName.trim();
    if (saving || name === pet.name) {
      return;
    }

    saving = true;
    try {
      const updatedPet = await updatePet({ id: pet.id, petUpdateDto: { name } });
      draftName = updatedPet.name;
      onUpdate({ ...pet, ...updatedPet });
    } catch (error) {
      draftName = pet.name;
      handleError(error, $t('failed_to_update_pet'));
    } finally {
      saving = false;
    }
  };

  const hidePet = async () => {
    try {
      const updatedPet = await updatePet({ id: pet.id, petUpdateDto: { isHidden: true } });
      onUpdate({ ...pet, ...updatedPet });
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const changeSpecies = async (event: Event) => {
    const species = (event.currentTarget as HTMLSelectElement).value as Species;
    if (savingSpecies || species === pet.species) {
      return;
    }

    savingSpecies = true;
    try {
      const updatedPet = await updatePet({ id: pet.id, petUpdateDto: { species } });
      onUpdate({ ...pet, ...updatedPet });
    } catch (error) {
      (event.currentTarget as HTMLSelectElement).value = pet.species;
      handleError(error, $t('failed_to_update_pet'));
    } finally {
      savingSpecies = false;
    }
  };
</script>

<article
  class="group relative rounded-xl border-2 border-transparent p-2 transition-all hover:border-immich-primary/50 hover:bg-gray-200 hover:shadow-sm hover:dark:border-immich-dark-primary/25 dark:hover:bg-immich-dark-primary/20"
  role="group"
  onmouseenter={() => (showOptions = true)}
  onmouseleave={() => (showOptions = false)}
  use:focusOutside={{ onFocusOut: () => (showOptions = false) }}
>
  <a
    href={Route.viewPet(pet, { previousRoute: Route.pets() })}
    aria-label={pet.name || $t('unrecognized_pet')}
    class="block"
    draggable="false"
    onfocus={() => (showOptions = true)}
  >
    <PetThumbnail
      {pet}
      class="aspect-square rounded-full shadow-md ring-1 ring-black/5 transition-transform duration-200 group-hover:scale-[1.015]"
    />
  </a>

  {#if showOptions}
    <div class="absolute top-3 right-3 z-10">
      <ButtonContextMenu
        buttonClass="icon-white-drop-shadow"
        color="secondary"
        size="medium"
        variant="filled"
        icon={mdiDotsVertical}
        title={$t('show_pet_options')}
      >
        <MenuOption onClick={hidePet} icon={mdiEyeOff} text={$t('hide_pet')} />
        <MenuOption onClick={() => onMerge(pet)} icon={mdiCallMerge} text={$t('merge_pets')} />
      </ButtonContextMenu>
    </div>
  {/if}

  <form
    class="mt-2"
    onsubmit={(event) => {
      event.preventDefault();
      void saveName();
    }}
  >
    <input
      type="text"
      class="w-full rounded-2xl border-gray-100 bg-white py-2 text-center text-sm text-primary placeholder-gray-400 transition-shadow outline-none focus:ring-2 focus:ring-immich-primary/50 disabled:opacity-60 dark:border-gray-900 dark:bg-immich-dark-gray"
      aria-label={$t('pet_name')}
      placeholder={$t('add_a_name')}
      disabled={saving}
      bind:value={draftName}
      onblur={() => void saveName()}
    />
  </form>

  <div class="mt-1 flex items-center justify-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
    <select
      class="cursor-pointer appearance-none rounded-full border-0 bg-transparent py-0 ps-1 pe-3 text-center text-xs text-gray-500 capitalize outline-none hover:text-immich-primary focus:ring-2 focus:ring-immich-primary/40 disabled:cursor-wait disabled:opacity-60 dark:text-gray-400 dark:hover:text-immich-dark-primary"
      aria-label={$t('pet_category')}
      value={pet.species}
      disabled={savingSpecies}
      onchange={changeSpecies}
    >
      <option value="cat">{$t('pet_category_cat')}</option>
      <option value="dog">{$t('pet_category_dog')}</option>
    </select>
    <span aria-hidden="true">·</span>
    <span>{$t('items_count', { values: { count: pet.assetCount ?? 0 } })}</span>
  </div>
</article>
