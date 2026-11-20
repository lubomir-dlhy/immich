import { authenticate } from '#lib/utils/auth.ts';
import { getFormatter } from '#lib/utils/i18n.ts';
import { getPet } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async ({ params, url }) => {
  await authenticate(url);

  const pet = await getPet({ id: params.petId });
  const $t = await getFormatter();

  return {
    pet,
    meta: {
      title: pet.name || $t('unrecognized_pet'),
    },
  };
}) satisfies PageLoad;
