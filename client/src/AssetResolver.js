import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

export class AssetResolver {
  constructor(scene, endpoint = 'https://cloud.nitroxr.com') {
    this.scene = scene;
    this.endpoint = endpoint;
    this.loader = new GLTFLoader();
    this.cache = new Map(); // assetId -> { mesh, material }
    this.inflight = new Map(); // assetId -> shared promise (dedupes concurrent resolves)
    this.loadingQueue = [];
    this.isProcessing = false;
  }

  async resolve(assetId, priority = 4) {
    if (this.cache.has(assetId)) {
      return this.cache.get(assetId);
    }
    // Concurrent callers for the same id share one fetch + one GLB load
    // instead of each queueing their own (e.g. 100 maze walls, 1 fetch).
    if (!this.inflight.has(assetId)) {
      const pending = new Promise((resolve) => {
        this.loadingQueue.push({ assetId, priority, resolve });
        this.loadingQueue.sort((a, b) => a.priority - b.priority);
        this.processQueue();
      }).finally(() => {
        this.inflight.delete(assetId);
      });
      this.inflight.set(assetId, pending);
    }
    return this.inflight.get(assetId);
  }

  async processQueue() {
    if (this.isProcessing || this.loadingQueue.length === 0) return;
    this.isProcessing = true;

    const { assetId, resolve } = this.loadingQueue.shift();

    try {
      // 1. Query the Cloud Body for metadata
      const base = (typeof globalThis !== 'undefined' && globalThis.NitroXR && globalThis.NitroXR.Cloud && globalThis.NitroXR.Cloud.endpoint) || this.endpoint;
      const response = await fetch(`${base}/assets/${assetId}`);
      if (!response.ok) throw new Error(`Asset ${assetId} not found`);
      
      const metadata = await response.json();
      const { glb_url, audio_url, properties = {}, type = 'model' } = metadata;

      // Audio assets: return metadata with URL directly (no GLB load)
      if (type === 'audio' || audio_url) {
        const asset = { metadata: { ...metadata, audio_url: audio_url || glb_url } };
        this.cache.set(assetId, asset);
        resolve(asset);
        return;
      }

      // Registry entry without a binary yet (e.g. seed templates before R2
      // upload): use the fallback primitive instead of erroring the loop.
      if (!glb_url) {
        const asset = { model: this.createFallbackModel(), metadata };
        this.cache.set(assetId, asset);
        resolve(asset);
        return;
      }

      // 2. Stream the GLB from R2/CDN
      const gltf = await this.loader.loadAsync(glb_url);
      const model = gltf.scene;

      // 3. Apply PBR Properties from metadata
      model.traverse((child) => {
        if (child.isMesh) {
          child.material.metalness = properties.metallic ?? 0.5;
          child.material.roughness = properties.roughness ?? 0.5;
        }
      });

      // 4. Apply registry scale (number = uniform, array = xyz). Calibrates
      // AI-generated models to world units without touching game code.
      const s = properties.scale;
      if (s !== undefined) {
        const [sx, sy, sz] = Array.isArray(s) ? s : [s, s, s];
        model.scale.set(sx ?? 1, sy ?? 1, sz ?? 1);
      }

      const asset = { model, metadata };
      this.cache.set(assetId, asset);
      resolve(asset);
    } catch (e) {
      console.error(`NitroXR: Failed to resolve asset ${assetId}:`, e);
      resolve({ model: this.createFallbackModel(), metadata: { error: true } });
    } finally {
      this.isProcessing = false;
      this.processQueue();
    }
  }

  createFallbackModel() {
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: 0xff00ff }); // Magenta error color
    return new THREE.Mesh(geo, mat);
  }
}
