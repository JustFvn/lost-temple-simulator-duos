import { BOARD } from "./geometry.js";

export const VIEW_SIZE = 360;
export const SIGHT_RADIUS = 155;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function cameraTarget(player) {
  const half = VIEW_SIZE / 2;
  return { x: clamp(player.x, half, BOARD - half), y: clamp(player.y, half, BOARD - half) };
}
export function followCamera(camera, player, dt, reducedMotion = false) {
  const target = cameraTarget(player);
  const blend = reducedMotion ? 1 : 1 - Math.exp(-12 * Math.max(0, dt));
  return { x: camera.x + (target.x - camera.x) * blend, y: camera.y + (target.y - camera.y) * blend };
}
export function projectPoint(point, camera, px) {
  return { x: (point.x - camera.x + VIEW_SIZE / 2) * px / VIEW_SIZE, y: (point.y - camera.y + VIEW_SIZE / 2) * px / VIEW_SIZE };
}

// Slab intersection of a unit ray and an axis-aligned solid wall.
function rayHit(origin, dx, dy, wall, limit) {
  let near = 0, far = limit;
  for (const [value, direction, min, max] of [[origin.x, dx, wall.x, wall.x + wall.w], [origin.y, dy, wall.y, wall.y + wall.h]]) {
    if (Math.abs(direction) < 1e-9) {
      if (value < min || value > max) return limit;
    } else {
      const a = (min - value) / direction, b = (max - value) / direction;
      near = Math.max(near, Math.min(a, b)); far = Math.min(far, Math.max(a, b));
      if (near > far) return limit;
    }
  }
  return far < 0 ? limit : near;
}
function rayDistance(origin, dx, dy, walls, radius) {
  let distance = radius;
  for (const wall of walls) distance = Math.min(distance, rayHit(origin, dx, dy, wall, distance));
  return distance;
}
export function isPointVisible(origin, point, walls, radius = SIGHT_RADIUS) {
  const dx = point.x - origin.x, dy = point.y - origin.y, distance = Math.hypot(dx, dy);
  if (distance > radius) return false;
  if (distance < 1e-6) return true;
  return rayDistance(origin, dx / distance, dy / distance, walls, distance) >= distance - 1e-6;
}
export function visibilityPolygon(origin, walls, radius = SIGHT_RADIUS) {
  const angles = Array.from({ length: 96 }, (_, i) => i * Math.PI * 2 / 96);
  // Corner rays preserve narrow doorways instead of making visibility flicker.
  for (const wall of walls) {
    if (Math.hypot(origin.x - clamp(origin.x, wall.x, wall.x + wall.w), origin.y - clamp(origin.y, wall.y, wall.y + wall.h)) > radius) continue;
    for (const x of [wall.x, wall.x + wall.w]) for (const y of [wall.y, wall.y + wall.h]) {
      const angle = Math.atan2(y - origin.y, x - origin.x);
      for (const offset of [-0.0001, 0, 0.0001]) angles.push((angle + offset + Math.PI * 2) % (Math.PI * 2));
    }
  }
  angles.sort((a, b) => a - b);
  return angles.map(angle => {
    const dx = Math.cos(angle), dy = Math.sin(angle);
    // Reveal just the front face of a wall, never the room behind it.
    const distance = Math.min(radius, rayDistance(origin, dx, dy, walls, radius) + 3);
    return { x: origin.x + dx * distance, y: origin.y + dy * distance };
  });
}
