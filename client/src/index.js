import * as THREE from 'three';
import { AssetResolver } from './AssetResolver.js';
import { PhysicsEngine } from './PhysicsEngine.js';
import { InputBridge } from './InputBridge.js';

// Scratch vector reused by getViewYaw().
const _viewDir = new THREE.Vector3();

export class Scene {
  constructor(canvas = null) {
    this.entities = new Map();
    this.physics = new PhysicsEngine();

    const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';

    // 1. Setup Three.js Core
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);

    const aspect = hasDOM ? window.innerWidth / window.innerHeight : 16 / 9;
    this.camera = new THREE.PerspectiveCamera(75, aspect, 0.1, 1000);

    // Camera rig: head pose drives the camera, locomotion drives the rig.
    // This is what keeps XR head-tracking working while the game moves the player.
    this.rig = new THREE.Group();
    this.camera.position.set(0, 1.6, 0);
    this.rig.add(this.camera);
    this.rig.position.set(0, 0, 5);
    this.scene.add(this.rig);

    this.renderer = new THREE.WebGLRenderer({
      canvas: canvas || (hasDOM ? document.createElement('canvas') : undefined),
      antialias: true
    });
    if (hasDOM) {
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(window.devicePixelRatio);
    }
    this.renderer.xr.enabled = true;

    if (hasDOM && !canvas) {
      document.body.appendChild(this.renderer.domElement);
    }

    // 2. Input + assets (Brain wiring)
    this.inputBridge = new InputBridge(this.renderer);
    this.assetResolver = new AssetResolver(this, Cloud.endpoint);
    this.audio = new AudioManager();

    // 3. Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    this.scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.position.set(5, 10, 7.5);
    this.scene.add(sunLight);

    if (hasDOM) {
      window.addEventListener('resize', () => {
        this.camera.aspect = window.innerWidth / window.innerHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(window.innerWidth, window.innerHeight);
      });
    }

    console.log("NitroXR: Visual Scene initialized with Three.js");
  }

  getInput() {
    return this.inputBridge.getInput();
  }

  // World-space yaw of the current view: the headset's heading while
  // presenting, otherwise the free camera's. Games should use this as the
  // locomotion basis in XR — driving movement from the avatar's own rotation
  // makes W move you where the avatar faces, not where you are looking, which
  // is the classic cause of VR nausea.
  getViewYaw() {
    this.camera.getWorldDirection(_viewDir);
    return Math.atan2(_viewDir.x, _viewDir.z);
  }

  isPresentingXR() {
    return !!this.renderer?.xr?.isPresenting;
  }

  moveRig(dx, dz) {
    this.rig.position.x += dx;
    this.rig.position.z += dz;
  }

  async enableVRButton() {
    if (typeof document === 'undefined') return null;
    const { VRButton } = await import('three/examples/jsm/webxr/VRButton.js');
    const button = VRButton.createButton(this.renderer);
    document.body.appendChild(button);
    return button;
  }

  startLoop(callback) {
    let lastTime = performance.now();
    this.renderer.setAnimationLoop(() => {
      const now = performance.now();
      const deltaTime = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;
      const input = this.inputBridge.getInput();
      input.deltaTime = deltaTime;
      callback(input);
    });
    return () => this.renderer.setAnimationLoop(null);
  }

  async createEntity(id, props = {}) {
    const { position = [0, 0, 0], model = 'cube', material = 'default', scale = [1, 1, 1], physics: physicsProps = {}, bounds: boundsProp = null } = props;

    // Resolve asset if it's a string ID
    let visualModel;
    if (typeof model === 'string' && model !== 'cube' && model !== 'sphere') {
      const asset = await this.assetResolver.resolve(model);
      // Audio assets resolve to metadata only (no GLB), so a typo that points
      // an entity at an audio id used to throw "cannot read .clone of
      // undefined" deep inside three.js. Fail with something actionable.
      if (!asset || !asset.model) {
        throw new Error(
          `Scene.createEntity('${id}'): asset '${model}' has no model. ` +
          `It resolved as type=${asset && asset.metadata && asset.metadata.type || 'unknown'}` +
          `${asset && asset.metadata && asset.metadata.audio_url ? ' (audio asset)' : ''}. ` +
          `Use scene.audio.loadAudio() for audio, or register a model asset.`
        );
      }
      visualModel = asset.model.clone();
    } else {
      if (model === 'cube') visualModel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
      else if (model === 'sphere') visualModel = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), new THREE.MeshStandardMaterial({ color: 0x808080 }));
      else visualModel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    }

    visualModel.position.set(...position);
    // Multiply (not set): preserves registry calibration from AssetResolver
    // while still allowing per-entity scale factors (default [1,1,1] = no-op).
    visualModel.scale.multiply(new THREE.Vector3(...scale));
    visualModel.name = id;

    this.scene.add(visualModel);

    const bounds = boundsProp || [scale[0] / 2 || 0.5, scale[1] / 2 || 0.5, scale[2] / 2 || 0.5];
    const entity = {
      id,
      position: [...position],
      model,
      material,
      mesh: visualModel,
      bounds,
      physics: {
        velocity: [0, 0, 0],
        mass: 1,
        isStatic: false,
        ...physicsProps
      },
      setPosition: (pos) => {
        entity.position = [...pos];
        visualModel.position.set(...pos);
      },
      update: (newProps) => {
        Object.assign(entity, newProps);
        if (newProps.position) {
          entity.position = [...newProps.position];
          visualModel.position.set(...newProps.position);
        }
      }
    };

    this.entities.set(id, entity);
    this.physics.addEntity(entity);
    return entity;
  }

  getEntity(id) {
    return this.entities.get(id);
  }

  removeEntity(id) {
    const entity = this.entities.get(id);
    if (entity) {
      this.scene.remove(entity.mesh);
      this.physics.removeEntity(entity);
      this.entities.delete(id);
    }
  }

  clear() {
    this.entities.forEach(entity => this.scene.remove(entity.mesh));
    this.entities.clear();
    this.physics.clear();
  }

  update(deltaTime) {
    this.physics.update(deltaTime);
    this.render();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export class Cloud {
  static endpoint = 'https://cloud.nitroxr.com';

  static setEndpoint(endpoint) {
    this.endpoint = endpoint;
  }

  static async submit(data) {
    return this.submitScore(data.userId, data.value ?? data.score, data.gameId);
  }

  static async submitScore(userId, value, gameId = 'maze') {
    try {
      const response = await fetch(`${this.endpoint}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, value, gameId })
      });
      return await response.json();
    } catch (e) {
      console.error("Cloud submit failed:", e);
      return { success: false };
    }
  }

  static async getLeaderboard(gameId = 'maze', limit = 10) {
    try {
      const response = await fetch(`${this.endpoint}/leaderboard/${encodeURIComponent(gameId)}?limit=${limit}`);
      return await response.json();
    } catch (e) {
      console.error("Cloud leaderboard fetch failed:", e);
      return { gameId, scores: [] };
    }
  }

  static async resolveAsset(assetId) {
    const response = await fetch(`${this.endpoint}/assets/${encodeURIComponent(assetId)}`);
    if (!response.ok) throw new Error(`Asset ${assetId} not found (${response.status})`);
    return response.json();
  }

  static async listAssets() {
    try {
      const response = await fetch(`${this.endpoint}/assets`);
      return await response.json();
    } catch (e) {
      console.error("Cloud asset list failed:", e);
      return { assets: [] };
    }
  }

  static async registerAsset(entry) {
    const response = await fetch(`${this.endpoint}/assets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry)
    });
    if (!response.ok) throw new Error(`Asset registration failed (${response.status})`);
    return response.json();
  }

  static async submitGhost(userId, path, gameId = 'maze') {
    const response = await fetch(`${this.endpoint}/ghost/${encodeURIComponent(userId)}?gameId=${encodeURIComponent(gameId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gameId, path })
    });
    if (!response.ok) throw new Error(`Ghost submit failed (${response.status})`);
    return response.json();
  }

  static async getGhost(userId, gameId = 'maze') {
    try {
      const response = await fetch(`${this.endpoint}/ghost/${encodeURIComponent(userId)}?gameId=${encodeURIComponent(gameId)}`);
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      console.error("Cloud ghost fetch failed:", e);
      return null;
    }
  }
}

export { InputBridge };
import { GhostRecorder, GhostPlayer, compressPath, decompressPath } from './GhostReplay.js';
export { GhostRecorder, GhostPlayer, compressPath, decompressPath };
import { AudioManager } from './AudioManager.js';
export { AudioManager };

// Shared keyboard-only bridge for the legacy global loop (desktop testing
// without a Scene instance). Scene instances use their own renderer-bound bridge.
let sharedBridge = null;
function getSharedBridge() {
  if (!sharedBridge) sharedBridge = new InputBridge(null);
  return sharedBridge;
}

export const NitroXR = {
  Scene,
  Cloud,
  InputBridge,
  GhostRecorder,
  GhostPlayer,
  onUpdate: (callback) => {
    const tick = () => {
      const now = Date.now();
      const deltaTime = (tick.lastTime) ? (now - tick.lastTime) / 1000 : 0.016;
      tick.lastTime = now;

      const input = getSharedBridge().getInput();
      input.deltaTime = deltaTime;
      callback(input);
      if (typeof requestAnimationFrame !== 'undefined') {
        requestAnimationFrame(tick);
      }
    };
    if (typeof requestAnimationFrame !== 'undefined') {
      requestAnimationFrame(tick);
    }
    return () => { tick.lastTime = null; };
  }
};

if (typeof globalThis !== 'undefined') {
  globalThis.NitroXR = NitroXR;
}
