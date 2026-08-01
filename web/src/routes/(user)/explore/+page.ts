import { getAllPeople, getExploreData, getPets } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const [items, response, pets] = await Promise.all([getExploreData(), getAllPeople({ withHidden: false }), getPets()]);
  const $t = await getFormatter();

  return {
    items,
    response,
    pets,
    meta: {
      title: $t('explore'),
    },
  };
}) satisfies PageLoad;
