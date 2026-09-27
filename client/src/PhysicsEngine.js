export class PhysicsEngine {
  constructor() {
    this.gravity = -9.81;
    this.entities = [];
  }

  addEntity(entity) {
    if (!this.entities.includes(entity)) {
      this.entities.push(entity);
    }
  }

  removeEntity(entity) {
    this.entities = this.entities.filter(e => e !== entity);
  }

  update(deltaTime) {
    for (const entity of this.entities) {
      this.applyPhysics(entity, deltaTime);
    }
  }

  applyPhysics(entity, deltaTime) {
    if (!entity.physics) return;

    const { velocity = [0, 0, 0], mass = 1, isStatic = false } = entity.physics;
    if (isStatic) return;

    // Simple Euler integration
    const newPos = [
      entity.position[0] + velocity[0] * deltaTime,
      entity.position[1] + velocity[1] * deltaTime,
      entity.position[2] + velocity[2] * deltaTime
    ];

    // Check collisions against all other static entities
    const correctedPos = this.resolveCollisions(entity, newPos);
    entity.setPosition(correctedPos);
  }

  resolveCollisions(entity, newPos) {
    let finalPos = [...newPos];
    const bounds = entity.bounds || [0.5, 0.5, 0.5];

    for (const other of this.entities) {
      if (other === entity || !other.physics?.isStatic) continue;

      const otherBounds = other.bounds || [0.5, 0.5, 0.5];
      
      // AABB Collision Detection
      const collision = this.checkAABB(
        finalPos, bounds,
        other.position, otherBounds
      );

      if (collision) {
        // Push out along the axis of least penetration
        const overlap = collision.overlap;
        const axis = collision.axis;
        
        finalPos[axis] -= overlap * (finalPos[axis] > other.position[axis] ? 1 : -1);
      }
    }
    return finalPos;
  }

  checkAABB(posA, sizeA, posB, sizeB) {
    const dx = posA[0] - posB[0];
    const px = (sizeA[0] + sizeB[0]) - Math.abs(dx);
    if (px <= 0) return null;

    const dy = posA[1] - posB[1];
    const py = (sizeA[1] + sizeB[1]) - Math.abs(dy);
    if (py <= 0) return null;

    const dz = posA[2] - posB[2];
    const pz = (sizeA[2] + sizeB[2]) - Math.abs(dz);
    if (pz <= 0) return null;

    // Find axis of minimum penetration
    const minOverlap = Math.min(px, py, pz);
    let axis = 0;
    if (minOverlap === py) axis = 1;
    else if (minOverlap === pz) axis = 2;

    return { overlap: minOverlap, axis: axis };
  }
}
