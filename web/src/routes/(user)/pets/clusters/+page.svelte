<script lang="ts">
  import { goto } from '$app/navigation';
  import PetThumbnail from '$lib/components/pets/PetThumbnail.svelte';
  import { Route } from '$lib/route';
  import { select } from 'd3-selection';
  import { zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
  import type { PetClusterPointDto } from '@immich/sdk';
  import { Icon, IconButton } from '@immich/ui';
  import {
    mdiArrowLeft,
    mdiEye,
    mdiEyeOff,
    mdiFitToScreenOutline,
    mdiInformationOutline,
    mdiMagnify,
    mdiMinus,
    mdiPlus,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const width = 1200;
  const height = 760;
  const padding = 90;
  const radius = (count = 0) => Math.min(25, 11 + Math.sqrt(Math.max(1, count)) * 2.2);
  let svgElement = $state<SVGSVGElement>();
  let zoomBehavior: ZoomBehavior<SVGSVGElement, unknown>;
  let plotTransform = $state('translate(0,0) scale(1)');
  let zoomScale = $state(1);
  let selectedId = $state<string>();
  let species = $state<'all' | 'dog' | 'cat'>('all');
  let search = $state('');
  let showHidden = $state(false);
  let showHelp = $state(false);
  let viewportWidth = $state(1200);

  const points = $derived(
    data.clusterMap.points.filter(
      (point) =>
        (showHidden || !point.isHidden) &&
        (species === 'all' || point.species === species) &&
        (!search || (point.name || $t('unrecognized_pet')).toLocaleLowerCase().includes(search.toLocaleLowerCase())),
    ),
  );
  const pointById = $derived(new Map(data.clusterMap.points.map((point) => [point.id, point])));
  const visiblePointIds = $derived(new Set(points.map(({ id }) => id)));
  const selected = $derived(visiblePointIds.has(selectedId ?? '') ? pointById.get(selectedId ?? '') : undefined);
  const selectedNeighbors = $derived(
    selected?.neighbors
      .map(({ petId, distance }) => ({ point: pointById.get(petId), distance }))
      .filter(
        (neighbor): neighbor is { point: PetClusterPointDto; distance: number } =>
          !!neighbor.point && visiblePointIds.has(neighbor.point.id),
      ) ?? [],
  );
  const renderedPoints = $derived(selected ? [selected, ...selectedNeighbors.map(({ point }) => point)] : points);
  // Keep the map readable while zooming: geometry expands, but visual markers
  // become slightly smaller instead of being magnified with the plot.
  const semanticScale = $derived(Math.pow(zoomScale, -1.15));
  const mapViewBox = $derived(selected && viewportWidth < 640 ? '300 70 600 620' : `0 0 ${width} ${height}`);
  const focusMaxDistance = $derived(
    Math.max(data.clusterMap.recognitionThreshold, ...selectedNeighbors.map(({ distance }) => distance)),
  );
  const focusRadius = 265;
  const focusInnerRadius = $derived(
    selected
      ? radius(selected.assetCount) +
          Math.max(0, ...selectedNeighbors.map(({ point }) => radius(point.assetCount))) +
          18
      : 0,
  );
  const focusDistanceRadius = (distance: number) =>
    focusInnerRadius + (distance / focusMaxDistance) * (focusRadius - focusInnerRadius);
  const overviewPositions = $derived.by(() => {
    const positions: Record<string, { x: number; y: number }> = Object.fromEntries(
      points.map((point) => [
        point.id,
        {
          x: padding + ((point.x + 1) / 2) * (width - padding * 2),
          y: padding + ((point.y + 1) / 2) * (height - padding * 2),
        },
      ]),
    );

    for (let iteration = 0; iteration < 60; iteration++) {
      for (const [index, left] of points.entries()) {
        for (let candidateIndex = index + 1; candidateIndex < points.length; candidateIndex++) {
          const right = points[candidateIndex];
          const leftPosition = positions[left.id];
          const rightPosition = positions[right.id];
          let deltaX = rightPosition.x - leftPosition.x;
          let deltaY = rightPosition.y - leftPosition.y;
          let distance = Math.hypot(deltaX, deltaY);
          const minimumDistance = radius(left.assetCount) + radius(right.assetCount) + 16;
          if (distance >= minimumDistance) {
            continue;
          }
          if (distance < 0.001) {
            const angle = ((index + 1) * (candidateIndex + 1) * 1.618) % (Math.PI * 2);
            deltaX = Math.cos(angle);
            deltaY = Math.sin(angle);
            distance = 1;
          }
          const adjustment = (minimumDistance - distance) / 2;
          const unitX = deltaX / distance;
          const unitY = deltaY / distance;
          leftPosition.x -= unitX * adjustment;
          leftPosition.y -= unitY * adjustment;
          rightPosition.x += unitX * adjustment;
          rightPosition.y += unitY * adjustment;
        }
      }
      for (const point of points) {
        const pointRadius = radius(point.assetCount) + 8;
        positions[point.id].x = Math.max(pointRadius, Math.min(width - pointRadius, positions[point.id].x));
        positions[point.id].y = Math.max(pointRadius, Math.min(height - pointRadius, positions[point.id].y));
      }
    }

    return positions;
  });
  const toX = (x: number) => padding + ((x + 1) / 2) * (width - padding * 2);
  const toY = (y: number) => padding + ((y + 1) / 2) * (height - padding * 2);
  const focusPositions = $derived.by(() => {
    const positions: Record<string, { x: number; y: number }> = {};
    if (!selected) {
      return positions;
    }

    const center = { x: width / 2, y: height / 2 };
    const selectedOverviewPosition = overviewPositions[selected.id] ?? {
      x: toX(selected.x),
      y: toY(selected.y),
    };
    const anchors: Record<string, { angle: number; radius: number }> = {};
    positions[selected.id] = center;

    for (const [index, neighbor] of selectedNeighbors.entries()) {
      const overviewPosition = overviewPositions[neighbor.point.id] ?? {
        x: toX(neighbor.point.x),
        y: toY(neighbor.point.y),
      };
      const deltaX = overviewPosition.x - selectedOverviewPosition.x;
      const deltaY = overviewPosition.y - selectedOverviewPosition.y;
      const angle =
        Math.hypot(deltaX, deltaY) > 0.001
          ? Math.atan2(deltaY, deltaX)
          : -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, selectedNeighbors.length);
      const radialDistance = focusDistanceRadius(neighbor.distance);
      anchors[neighbor.point.id] = { angle, radius: radialDistance };
      positions[neighbor.point.id] = {
        x: center.x + Math.cos(angle) * radialDistance,
        y: center.y + Math.sin(angle) * radialDistance,
      };
    }

    // Resolve thumbnail collisions tangentially. Reprojecting each point onto
    // its exact distance radius after every adjustment preserves the metric;
    // the weak anchor pull keeps its bearing close to the global projection.
    for (let iteration = 0; iteration < 80; iteration++) {
      for (const [index, left] of selectedNeighbors.entries()) {
        for (let candidateIndex = index + 1; candidateIndex < selectedNeighbors.length; candidateIndex++) {
          const right = selectedNeighbors[candidateIndex];
          const leftPosition = positions[left.point.id];
          const rightPosition = positions[right.point.id];
          let deltaX = rightPosition.x - leftPosition.x;
          let deltaY = rightPosition.y - leftPosition.y;
          let distance = Math.hypot(deltaX, deltaY);
          const minimumDistance = radius(left.point.assetCount) + radius(right.point.assetCount) + 18;
          if (distance >= minimumDistance) {
            continue;
          }
          if (distance < 0.001) {
            const fallbackAngle = ((index + 1) * (candidateIndex + 1) * 1.618) % (Math.PI * 2);
            deltaX = Math.cos(fallbackAngle);
            deltaY = Math.sin(fallbackAngle);
            distance = 1;
          }
          const adjustment = (minimumDistance - distance) / 2;
          const unitX = deltaX / distance;
          const unitY = deltaY / distance;
          leftPosition.x -= unitX * adjustment;
          leftPosition.y -= unitY * adjustment;
          rightPosition.x += unitX * adjustment;
          rightPosition.y += unitY * adjustment;
        }
      }

      for (const neighbor of selectedNeighbors) {
        const position = positions[neighbor.point.id];
        const anchor = anchors[neighbor.point.id];
        const adjustedAngle = Math.atan2(position.y - center.y, position.x - center.x);
        const angleDelta = Math.atan2(Math.sin(anchor.angle - adjustedAngle), Math.cos(anchor.angle - adjustedAngle));
        const anchoredAngle = adjustedAngle + angleDelta * 0.035;
        position.x = center.x + Math.cos(anchoredAngle) * anchor.radius;
        position.y = center.y + Math.sin(anchoredAngle) * anchor.radius;
      }
    }

    return positions;
  });
  const positionFor = (point: PetClusterPointDto) =>
    focusPositions[point.id] ?? overviewPositions[point.id] ?? { x: toX(point.x), y: toY(point.y) };
  const isClose = (distance: number) => distance <= data.clusterMap.recognitionThreshold;

  const resetZoom = () => {
    if (svgElement && zoomBehavior) {
      select(svgElement).call(zoomBehavior.transform, zoomIdentity);
    }
  };

  const zoomBy = (factor: number) => {
    if (svgElement && zoomBehavior) {
      select(svgElement).call(zoomBehavior.scaleBy, factor);
    }
  };

  const selectPet = (id: string) => {
    selectedId = id;
    resetZoom();
  };

  const showOverview = () => {
    selectedId = undefined;
    resetZoom();
  };

  onMount(() => {
    if (!svgElement) {
      return;
    }
    zoomBehavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.7, 8])
      .touchable(() => true)
      .clickDistance(8)
      .on('zoom', ({ transform }: { transform: ZoomTransform }) => {
        plotTransform = transform.toString();
        zoomScale = transform.k;
      });
    select(svgElement).call(zoomBehavior);
  });
</script>

<svelte:window bind:innerWidth={viewportWidth} />

<svelte:head>
  <title>{$t('pet_similarity_map')} - Immich</title>
</svelte:head>

<div class="min-h-screen bg-[#f4f1e9] text-[#1b2724] dark:bg-[#101817] dark:text-[#e8efe9]">
  <header
    class="sticky top-0 z-20 flex min-h-16 items-center gap-3 border-b border-black/10 bg-[#f4f1e9]/95 px-4 backdrop-blur-md sm:px-6 dark:border-white/10 dark:bg-[#101817]/95"
  >
    <IconButton
      icon={mdiArrowLeft}
      aria-label={$t('back')}
      size="medium"
      shape="round"
      color="secondary"
      variant="ghost"
      onclick={() => void goto(Route.pets())}
    />
    <div class="min-w-0 flex-1">
      <h1 class="truncate text-lg font-semibold tracking-tight">{$t('pet_similarity_map')}</h1>
      <p class="truncate text-xs text-[#61706b] dark:text-[#9aaba4]">
        {$t('pet_similarity_map_description')}
      </p>
    </div>
    <IconButton
      icon={mdiInformationOutline}
      aria-label={$t('about')}
      size="medium"
      shape="round"
      color="secondary"
      variant="ghost"
      onclick={() => (showHelp = !showHelp)}
    />
  </header>

  <main class="grid min-h-[calc(100vh-4rem)] lg:grid-cols-[minmax(0,1fr)_20rem]">
    <section class="relative min-h-152 overflow-hidden border-r border-black/10 dark:border-white/10">
      <div class="absolute top-4 left-4 z-10 flex flex-wrap items-center gap-2">
        <label
          class="flex h-10 items-center gap-2 rounded-full border border-black/10 bg-white/90 px-3 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-[#182321]/90"
        >
          <Icon icon={mdiMagnify} size="18" class="text-[#66756f]" />
          <input
            class="w-32 bg-transparent text-sm outline-none placeholder:text-[#7b8984] sm:w-44"
            placeholder={$t('search_pets')}
            bind:value={search}
          />
        </label>
        <div
          class="flex h-10 items-center rounded-full border border-black/10 bg-white/90 p-1 text-xs font-semibold shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-[#182321]/90"
        >
          {#each ['all', 'dog', 'cat'] as option (option)}
            <button
              type="button"
              class="rounded-full px-3 py-1.5 capitalize transition-colors {species === option
                ? 'bg-[#173f35] text-white dark:bg-[#9ed6bd] dark:text-[#10201b]'
                : 'text-[#62716c] hover:text-current dark:text-[#a6b5af]'}"
              onclick={() => (species = option as typeof species)}
            >
              {option === 'all' ? $t('all') : option === 'dog' ? $t('pet_category_dog') : $t('pet_category_cat')}
            </button>
          {/each}
        </div>
        <button
          type="button"
          class="flex size-10 items-center justify-center rounded-full border border-black/10 bg-white/90 shadow-sm backdrop-blur-sm transition-colors hover:bg-white dark:border-white/10 dark:bg-[#182321]/90 dark:hover:bg-[#22312e]"
          class:text-[#e58b35]={showHidden}
          aria-label={showHidden ? $t('hide_hidden_pets') : $t('show_hidden_pets')}
          title={showHidden ? $t('hide_hidden_pets') : $t('show_hidden_pets')}
          onclick={() => (showHidden = !showHidden)}
        >
          <Icon icon={showHidden ? mdiEyeOff : mdiEye} size="19" />
        </button>
      </div>

      {#if selected}
        <button
          type="button"
          class="absolute top-32 left-4 z-10 rounded-full border border-[#e58b35]/40 bg-[#fff7e8]/95 px-3 py-2 text-xs font-semibold text-[#8c4918] shadow-sm backdrop-blur-sm sm:top-18 dark:bg-[#312419]/95 dark:text-[#ffbb7a]"
          onclick={showOverview}
        >
          ← {$t('pet_map_overview')}
        </button>
      {/if}

      <div
        class="absolute right-4 bottom-16 z-10 flex flex-col overflow-hidden rounded-full border border-black/10 bg-white/90 shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-[#182321]/90"
      >
        <button
          type="button"
          class="flex size-10 items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={$t('zoom_in')}
          title={$t('zoom_in')}
          onclick={() => zoomBy(1.5)}
        >
          <Icon icon={mdiPlus} size="20" />
        </button>
        <button
          type="button"
          class="flex size-10 items-center justify-center border-y border-black/10 hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/10"
          aria-label={$t('zoom_out')}
          title={$t('zoom_out')}
          onclick={() => zoomBy(1 / 1.5)}
        >
          <Icon icon={mdiMinus} size="20" />
        </button>
        <button
          type="button"
          class="flex size-10 items-center justify-center hover:bg-black/5 dark:hover:bg-white/10"
          aria-label={$t('reset_view')}
          title={$t('reset_view')}
          onclick={resetZoom}
        >
          <Icon icon={mdiFitToScreenOutline} size="20" />
        </button>
      </div>

      <svg
        bind:this={svgElement}
        viewBox={mapViewBox}
        class="size-full min-h-152 cursor-grab touch-none active:cursor-grabbing"
        aria-label={$t('pet_similarity_map')}
      >
        <defs>
          <pattern id="atlas-grid" width="48" height="48" patternUnits="userSpaceOnUse">
            <path d="M 48 0 L 0 0 0 48" fill="none" stroke="currentColor" stroke-opacity="0.06" />
          </pattern>
        </defs>
        <rect {width} {height} fill="url(#atlas-grid)" />
        <g transform={plotTransform}>
          {#if selected}
            <circle
              cx={width / 2}
              cy={height / 2}
              r={focusDistanceRadius(data.clusterMap.recognitionThreshold)}
              fill="none"
              stroke="#e58b35"
              stroke-width="2"
              stroke-dasharray="8 8"
              opacity="0.55"
              vector-effect="non-scaling-stroke"
            />
            <text
              transform={`translate(${
                width / 2 + focusDistanceRadius(data.clusterMap.recognitionThreshold) + 8
              },${height / 2 - 8}) scale(${semanticScale})`}
              class="fill-[#b96826] text-[12px] font-semibold"
            >
              {$t('recognition_threshold')} · {data.clusterMap.recognitionThreshold.toFixed(3)}
            </text>
            {#each selectedNeighbors as neighbor (neighbor.point!.id)}
              {@const neighborPosition = positionFor(neighbor.point)}
              <line
                x1={width / 2}
                y1={height / 2}
                x2={neighborPosition.x}
                y2={neighborPosition.y}
                stroke={isClose(neighbor.distance) ? '#e58b35' : '#779189'}
                stroke-width={isClose(neighbor.distance) ? 3 : 1.5}
                stroke-dasharray={isClose(neighbor.distance) ? undefined : '6 7'}
                opacity="0.8"
                vector-effect="non-scaling-stroke"
              />
              <text
                transform={`translate(${(width / 2 + neighborPosition.x) / 2},${
                  (height / 2 + neighborPosition.y) / 2 - 7
                }) scale(${semanticScale})`}
                text-anchor="middle"
                class="fill-[#64736e] font-mono text-[12px] font-semibold dark:fill-[#a6b5af]"
              >
                {neighbor.distance.toFixed(3)}
              </text>
            {/each}
          {/if}

          {#each renderedPoints as point (point.id)}
            {@const isSelected = point.id === selectedId}
            {@const position = positionFor(point)}
            {@const nodeRadius = radius(point.assetCount) + (isSelected ? 5 : 1)}
            <g
              transform={`translate(${position.x},${position.y}) scale(${semanticScale})`}
              class="cursor-pointer outline-none"
              role="button"
              tabindex="0"
              aria-label={`${point.name || $t('unrecognized_pet')}, ${$t('items_count', {
                values: { count: point.assetCount ?? 0 },
              })}`}
              onclick={() => selectPet(point.id)}
              onkeydown={(event) => event.key === 'Enter' && selectPet(point.id)}
            >
              <title>
                {point.name || $t('unrecognized_pet')} · {$t('items_count', {
                  values: { count: point.assetCount ?? 0 },
                })}
              </title>
              <circle
                r={nodeRadius + 4}
                fill={isSelected ? '#e58b35' : point.species === 'cat' ? '#93a7d7' : '#68a88d'}
                stroke={isSelected ? '#fff7e8' : '#f4f1e9'}
                stroke-width={isSelected ? 4 : 2}
                class="transition-all duration-200"
              />
              <foreignObject
                x={-nodeRadius}
                y={-nodeRadius}
                width={nodeRadius * 2}
                height={nodeRadius * 2}
                class="pointer-events-none overflow-hidden rounded-full"
              >
                <PetThumbnail pet={point} class="size-full rounded-full" />
              </foreignObject>
              {#if point.name || isSelected}
                <text
                  y={radius(point.assetCount) + 22}
                  text-anchor="middle"
                  class="pointer-events-none fill-current text-[13px] font-semibold"
                  opacity="1"
                >
                  {point.name || $t('unrecognized_pet')}
                </text>
              {/if}
            </g>
          {/each}
        </g>
      </svg>

      <div
        class="pointer-events-none absolute bottom-4 left-4 rounded-xl border border-black/10 bg-white/85 px-3 py-2 text-[11px] text-[#64736e] shadow-sm backdrop-blur-sm dark:border-white/10 dark:bg-[#182321]/85 dark:text-[#9aaba4]"
      >
        {selected ? $t('pet_map_exact_neighborhood') : $t('pet_map_overview_approximate')}
      </div>
    </section>

    <aside class="border-t border-black/10 bg-white/45 p-5 lg:border-t-0 dark:border-white/10 dark:bg-black/10">
      {#if selected}
        <div class="flex items-center gap-3">
          <PetThumbnail pet={selected} class="size-16 shrink-0 rounded-2xl shadow-sm ring-1 ring-black/10" />
          <div class="min-w-0">
            <h2 class="truncate text-lg font-semibold">{selected.name || $t('unrecognized_pet')}</h2>
            <p class="text-sm text-[#66756f] capitalize dark:text-[#9aaba4]">
              {selected.species} · {$t('items_count', { values: { count: selected.assetCount ?? 0 } })}
            </p>
          </div>
        </div>

        <a
          href={Route.viewPet(selected, { previousRoute: Route.petClusters() })}
          class="mt-5 flex h-10 items-center justify-center rounded-xl bg-[#173f35] px-4 text-sm font-semibold text-white hover:bg-[#225b4c] focus-visible:ring-2 focus-visible:ring-[#e58b35] dark:bg-[#9ed6bd] dark:text-[#10201b]"
        >
          {$t('photos')}
        </a>

        <div class="mt-7">
          <div class="flex items-end justify-between gap-3">
            <h3 class="text-xs font-bold tracking-[0.16em] text-[#66756f] uppercase dark:text-[#9aaba4]">
              {$t('nearest_pets')}
            </h3>
            <span class="text-[10px] text-[#7d8b86]">{$t('cosine_distance')}</span>
          </div>
          <div class="mt-2 space-y-1.5">
            {#each selectedNeighbors as neighbor (neighbor.point!.id)}
              <button
                type="button"
                class="flex w-full items-center gap-2 rounded-xl border border-transparent p-2 text-left hover:border-black/10 hover:bg-white/80 dark:hover:border-white/10 dark:hover:bg-white/5"
                onclick={() => selectPet(neighbor.point.id)}
              >
                <PetThumbnail pet={neighbor.point!} class="size-9 shrink-0 rounded-lg" />
                <span class="min-w-0 flex-1 truncate text-sm font-medium">
                  {neighbor.point!.name || $t('unrecognized_pet')}
                </span>
                <span
                  class="rounded-full px-2 py-1 font-mono text-[11px] {isClose(neighbor.distance)
                    ? 'bg-[#e58b35]/15 text-[#a65718] dark:text-[#ffb875]'
                    : 'bg-black/5 text-[#64736e] dark:bg-white/5 dark:text-[#a6b5af]'}"
                >
                  {neighbor.distance.toFixed(3)}
                </span>
              </button>
            {/each}
          </div>
        </div>

        <div class="mt-6 rounded-2xl border border-black/10 p-4 text-xs/relaxed dark:border-white/10">
          <p class="font-semibold">{$t('recognition_threshold')}</p>
          <p class="mt-1 text-[#66756f] dark:text-[#9aaba4]">
            {$t('recognition_threshold_description', {
              values: { threshold: data.clusterMap.recognitionThreshold.toFixed(3) },
            })}
          </p>
        </div>
      {:else}
        <p class="text-sm text-[#66756f] dark:text-[#9aaba4]">{$t('select_pet_on_map')}</p>
      {/if}
    </aside>
  </main>

  {#if showHelp}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-sm"
      role="presentation"
      onclick={(event) => event.target === event.currentTarget && (showHelp = false)}
    >
      <div
        class="max-w-lg rounded-3xl bg-[#fffdf7] p-6 shadow-2xl dark:bg-[#182321]"
        role="dialog"
        aria-modal="true"
        aria-label={$t('about_pet_similarity_map')}
      >
        <h2 class="text-xl font-semibold">{$t('about_pet_similarity_map')}</h2>
        <p class="mt-3 text-sm/relaxed text-[#5f6e69] dark:text-[#a8b7b1]">
          {$t('pet_similarity_help')}
        </p>
        <button
          type="button"
          class="mt-5 rounded-xl bg-[#173f35] px-4 py-2 text-sm font-semibold text-white dark:bg-[#9ed6bd] dark:text-[#10201b]"
          onclick={() => (showHelp = false)}
        >
          {$t('done')}
        </button>
      </div>
    </div>
  {/if}
</div>
