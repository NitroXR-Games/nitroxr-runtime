import * as THREE from 'three';
import { AssetResolver } from './AssetResolver.js';
import { PhysicsEngine } from './PhysicsEngine.js';

export class Scene {
  constructor(canvas = null) {
    this.entities = new Map();
    this.assetResolver = new AssetResolver(this);
    this.physics = new PhysicsEngine();
    
    // 1. Setup Three.js Core
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111111);
    
    this.camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    this.camera.position.set(0, 1.6, 5); // Default eye level
    
    this.renderer = new THREE.WebGLRenderer({ 
      canvas: canvas || document.createElement('canvas'), 
      antialias: true 
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.xr.enabled = true;

    if (!canvas) {
      document.body.appendChild(this.renderer.domElement);
    }

    // 2. Lighting
    const ambientLight = new THREE.AmbientLight(0x404040, 2);
    this.scene.add(ambientLight);
    const sunLight = new THREE.DirectionalLight(0xffffff, 1);
    sunLight.position.set(5, 10, 7.5);
    this.scene.add(sunLight);

    console.log("NitroXR: Visual Scene initialized with Three.js");
  }

  async createEntity(id, props = {}) {
    const { position = [0, 0, 0], model = 'cube', material = 'default', scale = [1, 1, 1] } = props;

    // Resolve asset if it's a string ID
    let visualModel;
    if (typeof model === 'string' && model !== 'cube' && model !== 'sphere') {
      const asset = await this.assetResolver.resolve(model);
      visualModel = asset.model.clone();
    } else {
      if (model === 'cube') visualModel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
      else if (model === 'sphere') visualModel = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), new THREE.MeshStandardMaterial({ color: 0x808080 }));
      else visualModel = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x808080 }));
    }
    
    visualModel.position.set(...position);
    visualModel.scale.set(...scale);
    visualModel.name = id;

    this.scene.add(visualModel);

    const entity = {
      id,
      position,
      model,
      material,
      mesh: visualModel,
      setPosition: (pos) => {
        entity.position = pos;
        visualModel.position.set(...pos);
      },
      update: (newProps) => {
        Object.assign(entity, newProps);
        if (newProps.position) visualModel.position.set(...newProps.position);
      }
    };

    this.entities.set(id, entity);
    return entity;
  }

  getEntity(id) {
    return this.entities.get(id);
  }

  removeEntity(id) {
    const entity = this.entities.get(id);
    if (entity) {
      this.scene.remove(entity.mesh);
      this.entities.delete(id);
    }
  }

  clear() {
    this.entities.forEach(entity => this.scene.remove(entity.mesh));
    this.entities.clear();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}

export class Cloud {
  static endpoint = 'https://api.nitroxr.io';
  
  static async submit(data) {
    try {
      const response = await fetch(`${this.endpoint}/submit`, {
        method: 'POST',
        body: JSON.stringify(data)
      });
      return await response.json();
    } catch (e) {
      console.error("Cloud submit failed:", e);
      return { success: false };
    }
  }

  static async getGhost(userId) {
    try {
      const response = await fetch(`${this.endpoint}/ghost/${userId}`);
      return await response.json();
    } catch (e) {
      console.error("Cloud ghost fetch failed:", e);
      return null;
    }
  }
}

export const NitroXR = {
  Scene,
  Cloud,
  onUpdate: (callback) => {
    const tick = () => {
      const now = Date.now();
      const deltaTime = (tick.lastTime) ? (now - tick.lastTime) / 1000 : 0.016;
      tick.lastTime = now;

      callback({ 
        forward: false, backward: false, left: false, right: false,
        deltaTime: deltaTime,
        timestamp: now 
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
};
