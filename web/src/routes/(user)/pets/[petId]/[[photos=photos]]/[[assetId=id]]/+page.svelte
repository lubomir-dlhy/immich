<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import PetMergeModal from '$lib/modals/PetMergeModal.svelte';
  import PetReassignModal from '$lib/modals/PetReassignModal.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { handleError } from '$lib/utils/handle-error';
  import { isExternalUrl } from '$lib/utils/navigation';
  import { AssetVisibility, Species, getPets, updatePet, type PetResponseDto } from '@immich/sdk';
  import {
    ActionButton,
    CommandPaletteDefaultProvider,
    ContextMenuButton,
    modalManager,
    toastManager,
    type ActionItem,
  } from '@immich/ui';
  import { mdiArrowLeft, mdiCallMerge, mdiCat, mdiDog, mdiDotsVertical, mdiEyeOffOutline, mdiImageMove } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  let pet = $state(data.pet);
  let draftName = $state(data.pet.name);
  let savingName = $state(false);
  let previousRoute = $state<string>(Route.pets());
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = $derived({ visibility: AssetVisibility.Timeline, petId: pet.id });

  onMount(() => {
    const requestedPreviousRoute = page.url.searchParams.get('previousRoute');
    if (requestedPreviousRoute && !isExternalUrl(requestedPreviousRoute)) {
      previousRoute = requestedPreviousRoute;
    }
  });

  afterNavigate(({ from }) => {
    if (from?.url && from.route.id !== page.route.id) {
      previousRoute = from.url.href;
    }
  });

  const saveName = async () => {
    const name = draftName.trim();
    if (savingName || name === pet.name) {
      return;
    }

    savingName = true;
    try {
      pet = await updatePet({ id: pet.id, petUpdateDto: { name } });
      draftName = pet.name;
      toastManager.primary($t('change_name_successfully'));
    } catch (error) {
      draftName = pet.name;
      handleError(error, $t('failed_to_update_pet'));
    } finally {
      savingName = false;
    }
  };

  const setSpecies = async (species: Species) => {
    try {
      pet = await updatePet({ id: pet.id, petUpdateDto: { species } });
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const hidePet = async () => {
    try {
      await updatePet({ id: pet.id, petUpdateDto: { isHidden: true } });
      await goto(Route.pets());
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const mergePet = async () => {
    try {
      const pets = await getPets();
      const merged = await modalManager.show(PetMergeModal, {
        source: pet,
        candidates: pets.filter(
          (candidate: PetResponseDto) =>
            candidate.id !== pet.id && candidate.species === pet.species && !candidate.isHidden,
        ),
      });
      if (merged) {
        await goto(Route.viewPet(merged, { previousRoute: Route.pets() }), { replaceState: true });
      }
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const reassignSelectedAppearances = async () => {
    const assetIds = assetMultiSelectManager.assets.map(({ id }) => id);
    if (assetIds.length === 0) {
      return;
    }

    try {
      const pets = await getPets();
      const reassigned = await modalManager.show(PetReassignModal, {
        source: pet,
        assetIds,
        candidates: pets.filter(
          (candidate: PetResponseDto) =>
            candidate.id !== pet.id && candidate.species === pet.species && !candidate.isHidden,
        ),
      });
      if (reassigned) {
        timelineManager.removeAssets(assetIds);
        pet = { ...pet, assetCount: Math.max(0, (pet.assetCount ?? 0) - assetIds.length) };
        assetMultiSelectManager.clear();
      }
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const HidePet: ActionItem = {
    title: $t('hide_pet'),
    icon: mdiEyeOffOutline,
    onAction: hidePet,
  };
  const MergePet: ActionItem = {
    title: $t('merge_pets'),
    icon: mdiCallMerge,
    onAction: mergePet,
  };
  const MarkAsDog: ActionItem = {
    title: $t('pet_category_dog'),
    icon: mdiDog,
    $if: () => pet.species !== Species.Dog,
    onAction: () => setSpecies(Species.Dog),
  };
  const MarkAsCat: ActionItem = {
    title: $t('pet_category_cat'),
    icon: mdiCat,
    $if: () => pet.species !== Species.Cat,
    onAction: () => setSpecies(Species.Cat),
  };
</script>

<svelte:head>
  <title>{pet.name || $t('unrecognized_pet')} - Immich</title>
</svelte:head>

<main class="relative z-0 h-dvh overflow-hidden px-2 pt-(--navbar-height) md:px-6 md:pt-(--navbar-height-md)">
  {#key pet.id}
    <Timeline enableRouting={true} bind:timelineManager {options} assetInteraction={assetMultiSelectManager}>
      <div class="relative w-fit p-4 pt-12 sm:px-6">
        <section class="flex w-72 items-center sm:w-96">
          <PetThumbnail {pet} class="size-14 shrink-0 rounded-full shadow-md ring-1 ring-black/10" />
          <div class="min-w-0 flex-1 px-4">
            <form
              onsubmit={(event) => {
                event.preventDefault();
                void saveName();
              }}
            >
              <input
                class="w-full truncate border-0 bg-transparent p-0 font-medium text-primary outline-none focus:ring-0"
                aria-label={$t('pet_name')}
                placeholder={$t('add_a_name')}
                disabled={savingName}
                bind:value={draftName}
                onblur={() => void saveName()}
              />
            </form>
            <p class="text-sm text-gray-500 capitalize dark:text-gray-400">
              {pet.species} · {$t('assets_count', { values: { count: pet.assetCount ?? 0 } })}
            </p>
          </div>
        </section>
      </div>
    </Timeline>
  {/key}
</main>

<header>
  {#if assetMultiSelectManager.selectionActive}
    <AssetSelectControlBar>
      {@const Actions = getAssetBulkActions($t)}
      <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />
      <CreateSharedLink />
      <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
      <ActionButton action={Actions.AddToAlbum} />
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />
      <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
        <DownloadAction menuItem filename="{pet.name || 'pets'}.zip" />
        <MenuOption
          icon={mdiImageMove}
          text={$t('fix_incorrect_match')}
          onClick={() => void reassignSelectedAppearances()}
        />
      </ButtonContextMenu>
    </AssetSelectControlBar>
  {:else}
    <ControlAppBar backIcon={mdiArrowLeft} onClose={() => goto(previousRoute)}>
      {#snippet trailing()}
        <ContextMenuButton items={[HidePet, MergePet, MarkAsDog, MarkAsCat]} aria-label={$t('show_pet_options')} />
      {/snippet}
    </ControlAppBar>
  {/if}
</header>
