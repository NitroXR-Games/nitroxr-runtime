export class Scene {
  constructor() {
    this.entities = new Map();
    console.log("NitroXR: Scene initialized");
  }

  createEntity(id, props) {
    const entity = {
      id,
      ...props,
      setPosition: (pos) => { entity.position = pos; },
      update: (newProps) => { Object.assign(entity, newProps); }
    };
    this.entities.set(id, entity);
    return entity;
  }

  getEntity(id) {
    return this.entities.get(id);
  }

  removeEntity(id) {
    this.entities.delete(id);
  }

  clear() {
    this.entities.clear();
  }

  render() {
    // Integration point for Three.js / WebGL
  }
}

export class Cloud {
  static async submit(data) {
    const response = await fetch(`${this.endpoint}/submit`, {
      method: 'POST',
      body: JSON.stringify(data)
    });
    return response.json();
  }

  static async getGhost(userId) {
    const response = await fetch(`${this.endpoint}/ghost/${userId}`);
    return response.json();
  }

  static endpoint = 'https://api.nitroxr.io'; // Configurable via env
}

export const NitroXR = {
  Scene,
  Cloud,
  onUpdate: (callback) => {
    setInterval(() => {
      // Mock input object
      callback({ forward: true, backward: false, left: false, right: false });
    }, 16.6);
  }
};
