import { memoryManager } from '#lib/managers/memory-manager.svelte.ts';
import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { MemorySearchOrder, getAllPeople, getExploreData, getPets } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  memoryManager.setFilters({ size: 12, order: MemorySearchOrder.Desc });
  await memoryManager.applyPreferences();

  const [explore, people, , pets] = await Promise.all([
    getExploreData(),
    getAllPeople({ withHidden: false }),
    memoryManager.refresh(),
    getPets(),
  ]);
  const $t = await getFormatter();

  return {
    explore,
    people,
    pets,
    memories: memoryManager.memories,
    meta: {
      title: $t('explore'),
    },
  };
}) satisfies PageLoad;
