import type { AssetPetResponseDto } from '@immich/sdk';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { CancellableTask } from '$lib/utils/cancellable-task';

class PetManager {
  #data = $state<AssetPetResponseDto[]>([]);
  #loading = $state(false);
  #petLoader = new CancellableTask();
  #cleared = false;

  get data() {
    return this.#data;
  }

  get loading() {
    return this.#loading;
  }

  async getAssetPets(id: string) {
    if (this.#cleared) {
      await this.#petLoader.reset();
      this.#cleared = false;
    }

    await this.#petLoader.execute(async () => {
      this.#loading = true;
      try {
        this.#data = await assetCacheManager.getAssetPets(id);
      } finally {
        this.#loading = false;
      }
    }, false);
  }

  clear() {
    this.#cleared = true;
    this.#loading = false;
    this.#data = [];
  }

  invalidate() {
    this.clear();
    assetCacheManager.clearPetCache();
  }
}

export const petManager = new PetManager();
