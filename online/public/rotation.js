import { BOARD } from "./geometry.js";
import { VIEW_SIZE } from "./vision.js";

export const ROTATION_PERIOD_MS = 16000;
const TAU = Math.PI * 2;

export function rotationState(schedule, elapsedMs, reducedMotion = false) {
  const period = schedule.periodMs;
  const elapsed = Math.max(0, elapsedMs), phase = elapsed % period;
  const angle = reducedMotion ? Math.floor(phase / (period / 4)) * Math.PI / 2 : phase / period * TAU;
  return { angle, degrees: angle * 180 / Math.PI, remaining: period - phase };
}

export function rotateVector(x, y, angle) {
  const cos = Math.cos(angle), sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

export function screenToWorld(x, y, angle) {
  return rotateVector(x, y, -angle);
}

// A diagonal of the original square must fit inside the canvas at every angle.
export function rotationView(camera, px, fitDiagonal = true) {
  return { center: camera || { x: BOARD / 2, y: BOARD / 2 }, scale: px / ((camera ? VIEW_SIZE : BOARD) * (fitDiagonal ? Math.SQRT2 : 1)) };
}

export function projectRotatedPoint(point, camera, px, angle) {
  const { center, scale } = rotationView(camera, px);
  const delta = rotateVector(point.x - center.x, point.y - center.y, angle);
  return { x: px / 2 + delta.x * scale, y: px / 2 + delta.y * scale };
}
