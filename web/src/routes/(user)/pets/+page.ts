import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { getPets } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const pets = await getPets();
  const $t = await getFormatter();

  return {
    pets,
    meta: {
      title: $t('pets'),
    },
  };
}) satisfies PageLoad;
