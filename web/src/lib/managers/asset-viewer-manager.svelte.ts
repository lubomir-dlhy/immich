import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import type { ZoomImageWheelState } from '@zoom-image/core';
import { cubicOut } from 'svelte/easing';
import { authManager } from '$lib/managers/auth-manager.svelte';
import type { ImageLoaderStatus } from '$lib/utils/adaptive-image-loader.svelte';
import { canCopyImageToClipboard } from '$lib/utils/asset-utils';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { AssetGridRouteSearchParams } from '$lib/utils/navigation';
import { PersistedLocalStorage } from '$lib/utils/persisted';

export interface Faces {
  id: string;
  name?: string;
  imageHeight: number;
  imageWidth: number;
  boundingBoxX1: number;
  boundingBoxX2: number;
  boundingBoxY1: number;
  boundingBoxY2: number;
}

const isShowDetailPanel = new PersistedLocalStorage<boolean>('asset-viewer-state', false);
const isShowAssetPath = new PersistedLocalStorage<boolean>('asset-viewer-show-path', false);

const createDefaultZoomState = (): ZoomImageWheelState => ({
  currentRotation: 0,
  currentZoom: 1,
  enable: true,
  currentPositionX: 0,
  currentPositionY: 0,
});

export type Events = {
  Zoom: [];
  ZoomChange: [ZoomImageWheelState];
  Copy: [];
  FaceEditModeChange: [boolean];
  VideoTimeChange: [number];
  VideoSeek: [number];
  VideoFocus: [number];
};

class AssetViewerManager extends BaseEventManager<Events> {
  #zoomState = $state(createDefaultZoomState());
  #animationFrameId: number | null = null;

  imgRef = $state<HTMLImageElement | undefined>();
  imageLoaderStatus = $state<ImageLoaderStatus | undefined>();
  #isImageLoading = $derived.by(() => {
    const quality = this.imageLoaderStatus?.quality;
    if (!quality || this.imageLoaderStatus?.hasError) {
      return false;
    }
    const previewOrOriginalReady = quality.preview === 'success' || quality.original === 'success';
    const loadingOriginal = this.zoom > 1 && quality.original !== 'success';
    return !previewOrOriginalReady || loadingOriginal;
  });
  isShowActivityPanel = $state(false);
  isPlayingMotionPhoto = $state(false);
  isShowEditor = $state(false);
  #isFaceEditMode = $state(false);
  #annotationMode = $state<'people' | 'pets'>('people');
  #isEditFacesPanelOpen = $state(false);
  #viewingAssetStoreState = $state<AssetResponseDto>();
  #viewState = $state<boolean>(false);
  #highlightedFaces = $state<Faces[]>([]);
  #showingHiddenPeople = $state(false);
  #showingHiddenPets = $state(false);
  gridScrollTarget = $state<AssetGridRouteSearchParams | null | undefined>();

  get asset() {
    return this.#viewingAssetStoreState;
  }

  get isViewing() {
    return this.#viewState;
  }

  get isImageLoading() {
    return this.#isImageLoading;
  }

  get isShowDetailPanel() {
    return isShowDetailPanel.current;
  }

  get isShowAssetPath() {
    return isShowAssetPath.current;
  }

  get isFaceEditMode() {
    return this.#isFaceEditMode;
  }

  get annotationMode() {
    return this.#annotationMode;
  }

  get isEditFacesPanelOpen() {
    return this.#isEditFacesPanelOpen;
  }

  get zoomState() {
    return this.#zoomState;
  }

  set zoomState(state: ZoomImageWheelState) {
    this.#zoomState = state;
    this.emit('ZoomChange', state);
  }

  get zoom() {
    return this.#zoomState.currentZoom;
  }

  set zoom(zoom: number) {
    this.cancelZoomAnimation();
    this.zoomState = { ...this.zoomState, currentZoom: zoom };
  }

  canZoomIn() {
    return this.hasListeners('Zoom') && this.zoom <= 1;
  }

  canZoomOut() {
    return this.hasListeners('Zoom') && this.zoom > 1;
  }

  canCopyImage() {
    return canCopyImageToClipboard() && !!assetViewerManager.imgRef;
  }

  private set isShowDetailPanel(value: boolean) {
    isShowDetailPanel.current = value;
  }

  private set isShowAssetPath(value: boolean) {
    isShowAssetPath.current = value;
  }

  onZoomChange(state: ZoomImageWheelState) {
    // bypass event emitter to avoid loop
    this.#zoomState = state;
  }

  cancelZoomAnimation() {
    if (this.#animationFrameId !== null) {
      cancelAnimationFrame(this.#animationFrameId);
      this.#animationFrameId = null;
    }
  }

  animatedZoom(targetZoom: number, duration = 300) {
    this.cancelZoomAnimation();

    const startZoom = this.#zoomState.currentZoom;
    const startTime = performance.now();

    const frame = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const linearProgress = Math.min(elapsed / duration, 1);
      const easedProgress = cubicOut(linearProgress);
      const interpolatedZoom = startZoom + (targetZoom - startZoom) * easedProgress;

      this.zoomState = { ...this.#zoomState, currentZoom: interpolatedZoom };

      this.#animationFrameId = linearProgress < 1 ? requestAnimationFrame(frame) : null;
    };

    this.#animationFrameId = requestAnimationFrame(frame);
  }

  resetZoomState() {
    this.cancelZoomAnimation();
    this.zoomState = createDefaultZoomState();
  }

  toggleActivityPanel() {
    this.closeDetailPanel();
    this.isShowActivityPanel = !this.isShowActivityPanel;
  }

  closeActivityPanel() {
    this.isShowActivityPanel = false;
  }

  toggleAssetPath() {
    this.isShowAssetPath = !this.isShowAssetPath;
  }

  toggleDetailPanel() {
    this.closeActivityPanel();
    this.isShowDetailPanel = !this.isShowDetailPanel;
  }

  closeDetailPanel() {
    this.isShowDetailPanel = false;
  }

  openEditor() {
    this.closeActivityPanel();
    this.isShowEditor = true;
  }

  closeEditor() {
    this.isShowEditor = false;
  }

  toggleFaceEditMode() {
    const isClosing = this.#isFaceEditMode && this.#annotationMode === 'people';
    this.#annotationMode = 'people';
    this.#isFaceEditMode = !isClosing;
    this.emit('FaceEditModeChange', this.#isFaceEditMode);
  }

  togglePetEditMode() {
    const isClosing = this.#isFaceEditMode && this.#annotationMode === 'pets';
    this.#annotationMode = 'pets';
    this.#isFaceEditMode = !isClosing;
    this.emit('FaceEditModeChange', this.#isFaceEditMode);
  }

  closeFaceEditMode() {
    if (this.#isFaceEditMode) {
      this.emit('FaceEditModeChange', false);
    }
    this.#isFaceEditMode = false;
  }

  openEditFacesPanel() {
    this.#isEditFacesPanelOpen = true;
  }

  closeEditFacesPanel() {
    this.#isEditFacesPanelOpen = false;
  }

  resetPanelState() {
    this.closeEditor();
    this.closeFaceEditMode();
    this.closeEditFacesPanel();
  }

  get highlightedFaces() {
    return this.#highlightedFaces;
  }

  setHighlightedFaces(faces: Faces[]) {
    if (
      faces.length === this.#highlightedFaces.length &&
      faces.every((face, index) => face.id === this.#highlightedFaces[index]?.id)
    ) {
      return;
    }
    this.#highlightedFaces = faces;
  }

  clearHighlightedFaces() {
    if (this.#highlightedFaces.length === 0) {
      return;
    }
    this.#highlightedFaces = [];
  }

  get isShowingHiddenPeople() {
    return this.#showingHiddenPeople;
  }

  toggleHiddenPeople() {
    this.#showingHiddenPeople = !this.#showingHiddenPeople;
  }

  hideHiddenPeople() {
    this.#showingHiddenPeople = false;
  }

  get isShowingHiddenPets() {
    return this.#showingHiddenPets;
  }

  toggleHiddenPets() {
    this.#showingHiddenPets = !this.#showingHiddenPets;
  }

  hideHiddenPets() {
    this.#showingHiddenPets = false;
  }

  setVideoTime(seconds: number) {
    this.emit('VideoTimeChange', Math.max(0, seconds * 1000));
  }

  seekVideo(seconds: number) {
    this.emit('VideoSeek', Math.max(0, seconds));
  }

  focusVideo(seconds: number) {
    this.emit('VideoFocus', Math.max(0, seconds));
  }

  setAsset(asset: AssetResponseDto) {
    this.#viewingAssetStoreState = asset;
    this.#viewState = true;
  }

  async setAssetId(id: string): Promise<AssetResponseDto> {
    const asset = await getAssetInfo({ ...authManager.params, id });
    this.setAsset(asset);
    return asset;
  }

  showAssetViewer(show: boolean) {
    this.#viewState = show;
  }
}

export const assetViewerManager = new AssetViewerManager();
