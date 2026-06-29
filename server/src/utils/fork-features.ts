/**
 * Fork-specific feature flags (lubomir-dlhy/immich).
 *
 * These gate behavior that diverges from upstream immich-app/immich. Each flag
 * defaults to ON, and can be overridden per-instance with an environment
 * variable (set to one of: false, 0, no, off to disable).
 *
 * Kept in a standalone module so upstream merges never conflict here — call
 * sites read `forkFeatures.<flag>` and stay otherwise close to upstream.
 */

const FALSEY = new Set(['false', '0', 'no', 'off']);

const envFlag = (name: string, defaultValue: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') {
    return defaultValue;
  }
  return !FALSEY.has(raw.trim().toLowerCase());
};

export const forkFeatures = {
  /**
   * Include photos shared with the user via albums in their search results
   * (smart/CLIP search, OCR text search, metadata search, statistics).
   * ML for these assets is already computed; this surfaces it to the viewer.
   * Override: IMMICH_FORK_SHARED_ALBUM_SEARCH=false
   */
  sharedAlbumSearch: envFlag('IMMICH_FORK_SHARED_ALBUM_SEARCH', true),

  /**
   * Also recognize each detected face under the people catalogs of other users
   * who can access the asset (album members, partners), not just the owner.
   * Override: IMMICH_FORK_SHARED_FACE_RECOGNITION=false
   */
  sharedFaceRecognition: envFlag('IMMICH_FORK_SHARED_FACE_RECOGNITION', true),
};
