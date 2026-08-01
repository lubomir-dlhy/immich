<script lang="ts">
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import ActionMenuItem from '$lib/components/ActionMenuItem.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import PetSearchThumbnailOverlay from '$lib/components/pets/PetSearchThumbnailOverlay.svelte';
  import PetSearchHeader from '$lib/components/pets/PetSearchHeader.svelte';
  import PetReassignModal from '$lib/modals/PetReassignModal.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import ControlAppBar from '$lib/components/shared-components/ControlAppBar.svelte';
  import GalleryViewer from '$lib/components/shared-components/gallery-viewer/GalleryViewer.svelte';
  import SearchBar from '$lib/components/shared-components/search-bar/SearchBar.svelte';
  import ArchiveAction from '$lib/components/timeline/actions/ArchiveAction.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeDescription from '$lib/components/timeline/actions/ChangeDescriptionAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import CreateSharedLink from '$lib/components/timeline/actions/CreateSharedLinkAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import TagAction from '$lib/components/timeline/actions/TagAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import { QueryParameter } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import type { Viewport } from '$lib/managers/timeline-manager/types';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { lang, locale } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { parseUtcDate } from '$lib/utils/date-time';
  import { handleError } from '$lib/utils/handle-error';
  import { isAlbumsRoute, isPeopleRoute } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import {
    type AlbumResponseDto,
    type AssetResponseDto,
    AssetTypeEnum,
    AssetVisibility,
    getPet,
    getPerson,
    getPets,
    rejectPetAppearances,
    getTagById,
    type MetadataSearchDto,
    type PetResponseDto,
    searchAssets,
    searchSmart,
    type SmartSearchDto,
  } from '@immich/sdk';
  import {
    ActionButton,
    CommandPaletteDefaultProvider,
    Icon,
    IconButton,
    LoadingSpinner,
    modalManager,
    toastManager,
  } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiClose,
    mdiDotsVertical,
    mdiImageMove,
    mdiImageOffOutline,
    mdiPawOff,
    mdiSelectAll,
  } from '@mdi/js';
  import { tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const viewport: Viewport = $state({ width: 0, height: 0 });
  let searchResultsElement: HTMLElement | undefined = $state();

  // The GalleryViewer pushes it's own history state, which causes weird
  // behavior for history.back(). To prevent that we store the previous page
  // manually and navigate back to that.
  let previousRoute = $state<string>(Route.explore());

  let nextPage = $state(1);
  let searchResultAlbums: AlbumResponseDto[] = $state([]);
  let searchResultAssets: AssetResponseDto[] = $state([]);
  let isLoading = $state(true);
  let scrollY = $state(0);
  let scrollYHistory = 0;
  let petRevision = $state(0);
  const personNameRequests: Record<string, Promise<string>> = {};
  const petRequests: Record<string, Promise<PetResponseDto>> = {};
  const tagNameRequests: Record<string, Promise<string>> = {};

  type SearchTerms = MetadataSearchDto & Pick<SmartSearchDto, 'query' | 'queryAssetId'>;
  let searchQuery = $derived(page.url.searchParams.get(QueryParameter.QUERY));
  let smartSearchEnabled = $derived(featureFlagsManager.value.smartSearch);
  let terms = $derived<SearchTerms>(searchQuery ? JSON.parse(searchQuery) : {});
  let searchTermKeys = $derived(getObjectKeys(terms));
  let currentPetId = $derived(Array.isArray(terms.petIds) && terms.petIds.length === 1 ? terms.petIds[0] : undefined);

  $effect(() => {
    // Only the serialized URL query should restart the search. Tracking the
    // parsed object can repeatedly invalidate this effect while an asset
    // detail route is mounting.
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    searchQuery;
    untrack(() => handlePromiseError(onSearchQueryUpdate()));
  });

  $effect(() => {
    if (scrollY) {
      scrollYHistory = scrollY;
    }
  });

  afterNavigate(({ from }) => {
    // Prevent setting previousRoute to the current page.
    if (from?.url && from.route.id !== page.route.id) {
      previousRoute = from.url.href;
    }
    const route = from?.route?.id;

    if (isPeopleRoute(route)) {
      previousRoute = Route.photos();
    }

    if (isAlbumsRoute(route)) {
      previousRoute = Route.explore();
    }

    tick()
      .then(() => {
        window.scrollTo(0, scrollYHistory);
      })
      .catch(() => {
        // do nothing
      });
  });

  const onAssetDelete = (assetIds: string[]) => {
    const assetIdSet = new Set(assetIds);
    searchResultAssets = searchResultAssets.filter((asset: AssetResponseDto) => !assetIdSet.has(asset.id));
  };

  const handleSetVisibility = (assetIds: string[]) => {
    assetMultiSelectManager.clear();
    onAssetDelete(assetIds);
  };

  const handleSelectAll = () => {
    assetMultiSelectManager.selectAssets(searchResultAssets.map((asset) => toTimelineAsset(asset)));
  };

  const handleReassignPet = async () => {
    if (!currentPetId) {
      return;
    }

    try {
      const pets = await getPets();
      const source = pets.find(({ id }) => id === currentPetId);
      if (!source) {
        return;
      }

      const selectedAssetIds = assetMultiSelectManager.assets.map(({ id }) => id);
      const reassigned = await modalManager.show(PetReassignModal, {
        source,
        assetIds: selectedAssetIds,
        candidates: pets.filter(
          (pet: PetResponseDto) => pet.id !== source.id && pet.species === source.species && !pet.isHidden,
        ),
      });
      if (!reassigned) {
        return;
      }

      const selectedIds = new Set(selectedAssetIds);
      searchResultAssets = searchResultAssets.filter(({ id }) => !selectedIds.has(id));
      assetMultiSelectManager.clear();
    } catch (error) {
      handleError(error, $t('failed_to_update_pet'));
    }
  };

  const handleRejectPetAppearances = async () => {
    if (!currentPetId) {
      return;
    }

    const assetIds = assetMultiSelectManager.assets.map(({ id }) => id);
    const confirmed = await modalManager.showDialog({
      prompt: $t('not_a_pet_selected_confirmation', { values: { count: assetIds.length } }),
      confirmText: $t('not_a_pet'),
    });
    if (!confirmed) {
      return;
    }

    try {
      const { rejected } = await rejectPetAppearances({
        id: currentPetId,
        petRejectAppearancesDto: { assetIds },
      });
      assetMultiSelectManager.clear();
      toastManager.primary($t('not_a_pet_selected_count', { values: { count: rejected } }));
      await onPetAssignmentsUpdate();
    } catch (error) {
      handleError(error, $t('pet_assignment_failed'));
    }
  };

  async function onSearchQueryUpdate() {
    nextPage = 1;
    searchResultAssets = [];
    searchResultAlbums = [];
    await loadNextPage(true);
    if (currentPetId && nextPage === 0 && searchResultAssets.length === 0) {
      await goto(Route.pets(), { replaceState: true });
    }
  }

  // eslint-disable-next-line svelte/valid-prop-names-in-kit-pages
  export const loadNextPage = async (force?: boolean) => {
    if (!nextPage || (isLoading && !force)) {
      return;
    }
    isLoading = true;

    const searchDto: SearchTerms = {
      page: nextPage,
      withExif: true,
      ...terms,
    };

    try {
      const { albums, assets } =
        ('query' in searchDto || 'queryAssetId' in searchDto) && smartSearchEnabled
          ? await searchSmart({
              smartSearchDto: { visibility: AssetVisibility.Timeline, ...searchDto, language: $lang },
            })
          : await searchAssets({ metadataSearchDto: { visibility: AssetVisibility.Timeline, ...searchDto } });

      searchResultAlbums.push(...albums.items);
      searchResultAssets.push(...assets.items);

      nextPage = Number(assets.nextPage) || 0;
    } catch (error) {
      handleError(error, $t('loading_search_results_failed'));
    } finally {
      isLoading = false;
    }
  };

  function getHumanReadableDate(dateString: string) {
    const date = parseUtcDate(dateString).startOf('day');
    return date.toLocaleString(
      {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      },
      { locale: $locale },
    );
  }

  function getHumanReadableSearchKey(key: keyof SearchTerms): string {
    const keyMap: Partial<Record<keyof SearchTerms, string>> = {
      takenAfter: $t('start_date'),
      takenBefore: $t('end_date'),
      visibility: $t('in_archive'),
      isFavorite: $t('favorite'),
      isNotInAlbum: $t('not_in_any_album'),
      type: $t('media_type'),
      query: $t('context'),
      city: $t('city'),
      country: $t('country'),
      state: $t('state'),
      make: $t('camera_brand'),
      model: $t('camera_model'),
      lensModel: $t('lens_model'),
      personIds: $t('people'),
      petIds: $t('pets'),
      tagIds: $t('tags'),
      originalFileName: $t('file_name_text'),
      originalPath: $t('full_path_or_folder'),
      description: $t('description'),
      queryAssetId: $t('query_asset_id'),
      ocr: $t('ocr'),
    };
    return keyMap[key] || key;
  }

  function getPersonName(personIds: string[]) {
    const key = personIds.join(',');
    let request = personNameRequests[key];
    if (request === undefined) {
      request = Promise.all(
        personIds.map(async (personId) => {
          const person = await getPerson({ id: personId });
          return person.name || $t('no_name');
        }),
      ).then((personNames) => personNames.join(', '));
      personNameRequests[key] = request;
    }

    return request;
  }

  function getPetNames(petIds: string[]) {
    return Promise.all(
      petIds.map(async (petId) => {
        try {
          const pet = await getPetDetails(petId);
          return pet.name || $t('unrecognized_pet');
        } catch {
          // A saved/shared search can outlive access to the pet identity.
          // Keep the search usable even when its display label is no longer
          // available to the current user.
          return $t('unrecognized_pet');
        }
      }),
    ).then((petNames) => petNames.join(', '));
  }

  function getPetDetails(petId: string) {
    return (petRequests[petId] ??= getPet({ id: petId }));
  }

  function getTagNames(tagIds: string[] | null) {
    if (tagIds === null) {
      return Promise.resolve($t('untagged'));
    }

    const key = tagIds.join(',');
    let request = tagNameRequests[key];
    if (request === undefined) {
      request = Promise.all(
        tagIds.map(async (tagId) => {
          const tag = await getTagById({ id: tagId });
          return tag.value;
        }),
      ).then((tagNames) => tagNames.join(', '));
      tagNameRequests[key] = request;
    }

    return request;
  }

  const onAlbumAddAssets = ({ assetIds }: { assetIds: string[] }) => {
    assetMultiSelectManager.clear();

    if (terms.isNotInAlbum) {
      const assetIdSet = new Set(assetIds);
      searchResultAssets = searchResultAssets.filter((asset) => !assetIdSet.has(asset.id));
    }
  };

  const onPetAssignmentsUpdate = async () => {
    if (!currentPetId) {
      return;
    }

    delete petRequests[currentPetId];
    petRevision++;
    await onSearchQueryUpdate();
  };

  function getObjectKeys<T extends object>(obj: T): (keyof T)[] {
    return Object.keys(obj) as (keyof T)[];
  }

  function removeFilter(key: keyof SearchTerms) {
    delete terms[key];
    assetMultiSelectManager.clear();
    void goto(Route.search(terms));
  }
</script>

<svelte:window bind:scrollY />

<OnEvents {onAlbumAddAssets} {onPetAssignmentsUpdate} />

{#if searchTermKeys.length > 0}
  <section id="search-chips" class="mx-auto mt-24 w-full max-w-7xl px-4 sm:px-8 lg:px-12">
    <div class="flex w-full flex-wrap place-content-center place-items-center gap-2.5 sm:gap-3">
      {#each searchTermKeys as searchKey (searchKey)}
        {@const value = terms[searchKey]}
        <div
          class="inline-flex max-w-full items-center rounded-full bg-primary/10 py-1 ps-1 pe-1 text-xs text-primary ring-1 ring-primary/15 transition-shadow hover:ring-primary/25 dark:bg-immich-dark-primary/15 dark:text-immich-dark-primary dark:ring-immich-dark-primary/20 dark:hover:ring-immich-dark-primary/30"
        >
          <span
            class="shrink-0 rounded-full bg-primary px-3 py-1.5 font-medium text-light dark:bg-immich-dark-primary dark:text-immich-dark-gray"
          >
            {getHumanReadableSearchKey(searchKey as keyof SearchTerms)}
          </span>

          {#if value !== true}
            <span class="max-w-[min(36rem,55vw)] min-w-0 truncate px-3 py-1.5 text-immich-fg dark:text-immich-dark-fg">
              {#if (searchKey === 'takenAfter' || searchKey === 'takenBefore') && typeof value === 'string'}
                {getHumanReadableDate(value)}
              {:else if searchKey === 'personIds' && Array.isArray(value)}
                {#await getPersonName(value) then personName}
                  {personName}
                {/await}
              {:else if searchKey === 'petIds' && Array.isArray(value)}
                {#await getPetNames(value) then petNames}
                  {petNames}
                {/await}
              {:else if searchKey === 'tagIds' && (Array.isArray(value) || value === null)}
                {#await getTagNames(value) then tagNames}
                  {tagNames}
                {/await}
              {:else if searchKey === 'rating'}
                {$t('rating_count', { values: { count: value ?? 0 } })}
              {:else if value === null || value === ''}
                {$t('unknown')}
              {:else}
                {value}
              {/if}
            </span>
          {/if}

          <button
            type="button"
            class="ms-0.5 flex size-7 shrink-0 items-center justify-center rounded-full text-primary outline-offset-2 outline-immich-primary transition-colors hover:bg-primary/15 focus-visible:outline-2 dark:text-immich-dark-primary dark:outline-immich-dark-primary dark:hover:bg-immich-dark-primary/20"
            aria-label={$t('remove_filter')}
            title={$t('remove_filter')}
            onclick={() => removeFilter(searchKey)}
          >
            <Icon icon={mdiClose} size="14" />
          </button>
        </div>
      {/each}
    </div>
  </section>
{/if}

{#if currentPetId}
  {#key `${currentPetId}:${petRevision}`}
    <PetSearchHeader petId={currentPetId} petPromise={getPetDetails(currentPetId)} />
  {/key}
{/if}

<section
  class="m-4 mb-12 max-h-screen bg-immich-bg dark:bg-immich-dark-bg"
  bind:clientHeight={viewport.height}
  bind:clientWidth={viewport.width}
  bind:this={searchResultsElement}
>
  <section id="search-content">
    {#if searchResultAssets.length > 0}
      <GalleryViewer
        assets={searchResultAssets}
        assetInteraction={assetMultiSelectManager}
        onEndReached={loadNextPage}
        showArchiveIcon={true}
        {viewport}
        onReload={onSearchQueryUpdate}
        slidingWindowOffset={searchResultsElement.offsetTop}
      >
        {#snippet customThumbnailLayout(asset: AssetResponseDto, selected: boolean)}
          {#if currentPetId && !assetViewerManager.isViewing}
            <PetSearchThumbnailOverlay
              assetId={asset.id}
              petId={currentPetId}
              isVideo={asset.type === AssetTypeEnum.Video}
              {selected}
            />
          {/if}
        {/snippet}
      </GalleryViewer>
    {:else if !isLoading}
      <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center dark:text-white">
        <div class="flex flex-col content-center items-center text-center">
          <Icon icon={mdiImageOffOutline} size="3.5em" />
          <p class="mt-5 text-3xl font-medium">{$t('no_results')}</p>
          <p class="text-base font-normal">{$t('no_results_description')}</p>
        </div>
      </div>
    {/if}

    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <LoadingSpinner size="giant" />
      </div>
    {/if}
  </section>

  <section>
    {#if assetMultiSelectManager.selectionActive}
      <div class="fixed inset-s-0 top-0 z-2 w-full">
        <AssetSelectControlBar>
          {@const Actions = getAssetBulkActions($t)}
          <CommandPaletteDefaultProvider name={$t('assets')} actions={Object.values(Actions)} />

          <CreateSharedLink />
          {#if currentPetId}
            <IconButton
              shape="round"
              color="secondary"
              variant="ghost"
              aria-label={$t('reassign_pet_photos')}
              title={$t('reassign_pet_photos')}
              icon={mdiImageMove}
              onclick={handleReassignPet}
            />
            {#if assetMultiSelectManager.isAllUserOwned}
              <IconButton
                shape="round"
                color="secondary"
                variant="ghost"
                aria-label={$t('not_a_pet')}
                title={$t('not_a_pet')}
                icon={mdiPawOff}
                onclick={handleRejectPetAppearances}
              />
            {/if}
          {/if}
          <IconButton
            shape="round"
            color="secondary"
            variant="ghost"
            aria-label={$t('select_all')}
            icon={mdiSelectAll}
            onclick={handleSelectAll}
          />
          <ActionButton action={Actions.AddToAlbum} />
          {#if assetMultiSelectManager.isAllUserOwned}
            <FavoriteAction
              removeFavorite={assetMultiSelectManager.isAllFavorite}
              onFavorite={(ids, isFavorite) => {
                for (const id of ids) {
                  const asset = searchResultAssets.find((asset) => asset.id === id);
                  if (asset) {
                    asset.isFavorite = isFavorite;
                  }
                }
              }}
            />

            <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
              <ActionMenuItem action={Actions.AddToAlbum} />
              <DownloadAction menuItem />
              <ChangeDate menuItem />
              <ChangeDescription menuItem />
              <ChangeLocation menuItem />
              <ArchiveAction menuItem unarchive={assetMultiSelectManager.isAllArchived} />
              <SetVisibilityAction menuItem onVisibilitySet={handleSetVisibility} />
              {#if authManager.preferences.tags.enabled}
                <TagAction menuItem />
              {/if}
              <DeleteAssets menuItem {onAssetDelete} onUndoDelete={onSearchQueryUpdate} />
              <hr />
              <ActionMenuItem action={Actions.RegenerateThumbnailJob} />
              <ActionMenuItem action={Actions.RefreshMetadataJob} />
              <ActionMenuItem action={Actions.TranscodeVideoJob} />
            </ButtonContextMenu>
          {:else}
            <DownloadAction />
          {/if}
        </AssetSelectControlBar>
      </div>
    {:else}
      <div class="fixed inset-s-0 top-0 z-2 w-full">
        <ControlAppBar onClose={() => goto(previousRoute)} backIcon={mdiArrowLeft}>
          <div class="mx-auto w-full max-w-2xl pe-2">
            <SearchBar grayTheme={false} value={terms?.query ?? ''} searchQuery={terms} />
          </div>
        </ControlAppBar>
      </div>
    {/if}
  </section>
</section>
