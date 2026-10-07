import { BOARD } from "./geometry.js";

export const VIEW_SIZE = 360;
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
