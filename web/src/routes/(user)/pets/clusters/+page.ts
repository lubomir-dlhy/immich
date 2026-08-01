import { getPetClusters } from '@immich/sdk';
import type { PageLoad } from './$types';

export const load = (async () => {
  return { clusterMap: await getPetClusters() };
}) satisfies PageLoad;
