import { getAssetInfo, getAssetOcr, getAssetPets, getFaces } from '@immich/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

const defaultSerializer = <K>(params: K) => JSON.stringify(params);

class AsyncCache<K, V> {
  #cache = new Map<string, V>();
  #pending = new Map<string, Promise<V>>();

  constructor(private fetcher: (params: K) => Promise<V>) {}

  async getOrFetch(params: K, updateCache: boolean): Promise<V> {
    const cacheKey = defaultSerializer(params);

    const cached = this.#cache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = this.#pending.get(cacheKey);
    if (pending) {
      return pending;
    }

    const request = this.fetcher(params);
    this.#pending.set(cacheKey, request);
    try {
      const value = await request;
      if (value && updateCache && this.#pending.get(cacheKey) === request) {
        this.#cache.set(cacheKey, value);
      }
      return value;
    } finally {
      if (this.#pending.get(cacheKey) === request) {
        this.#pending.delete(cacheKey);
      }
    }
  }

  clearKey(params: K) {
    const cacheKey = defaultSerializer(params);
    this.#cache.delete(cacheKey);
    this.#pending.delete(cacheKey);
  }

  clear() {
    this.#cache.clear();
    this.#pending.clear();
  }
}

class AssetCacheManager {
  #assetCache = new AsyncCache(getAssetInfo);
  #ocrCache = new AsyncCache(getAssetOcr);
  #faceCache = new AsyncCache(getFaces);
  #petCache = new AsyncCache(getAssetPets);

  constructor() {
    eventManager.on({
      AssetEditsApplied: (assetId) => {
        this.invalidateAsset(assetId);
      },
      AssetUpdate: (asset) => {
        this.invalidateAsset(asset.id);
      },
    });
  }

  async getAsset({ id, key, slug }: { id: string; key?: string; slug?: string }, updateCache = true) {
    return this.#assetCache.getOrFetch({ id, key, slug }, updateCache);
  }

  async getAssetOcr(id: string) {
    return this.#ocrCache.getOrFetch({ id }, true);
  }

  async getAssetFaces(id: string) {
    return this.#faceCache.getOrFetch({ id }, true);
  }

  async getAssetPets(id: string) {
    return this.#petCache.getOrFetch({ id }, true);
  }

  invalidateAsset(id: string) {
    const { key, slug } = authManager.params;
    this.#assetCache.clearKey({ id, key, slug });
    this.#ocrCache.clearKey({ id });
    this.#faceCache.clearKey({ id });
    this.#petCache.clearKey({ id });
  }

  clearAssetCache() {
    this.#assetCache.clear();
  }

  clearOcrCache() {
    this.#ocrCache.clear();
  }

  clearFaceCache() {
    this.#faceCache.clear();
  }

  clearPetCache() {
    this.#petCache.clear();
  }

  invalidate() {
    this.clearAssetCache();
    this.clearOcrCache();
    this.clearFaceCache();
    this.clearPetCache();
  }
}

export const assetCacheManager = new AssetCacheManager();
