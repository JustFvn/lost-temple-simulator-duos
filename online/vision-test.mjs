import assert from "node:assert/strict";
import { VIEW_SIZE, SIGHT_RADIUS, cameraTarget, followCamera, projectPoint, isPointVisible, visibilityPolygon } from "./public/vision.js";
import { buildWalls } from "./public/geometry.js";
import { generateMaze } from "./maze.js";

assert(VIEW_SIZE < 820, "黑霧視角必須放大盤面");
assert.deepEqual(cameraTarget({ x: 0, y: 820 }), { x: 180, y: 640 });
assert.deepEqual(cameraTarget({ x: 410, y: 410 }), { x: 410, y: 410 });
assert.deepEqual(projectPoint({ x: 410, y: 410 }, { x: 410, y: 410 }, 640), { x: 320, y: 320 });
const before = { x: 250, y: 640 }, player = { x: 410, y: 570 };
const next = followCamera(before, player, 1 / 60);
assert(next.x > before.x && next.x < player.x); assert(next.y < before.y && next.y > player.y);
assert.deepEqual(followCamera(before, player, 1 / 60, true), cameraTarget(player), "減少動態效果時立即跟隨");
assert.deepEqual(followCamera(before, player, 0), before);

const origin = { x: 392, y: 730 }, partner = { x: 428, y: 730 };
assert(isPointVisible(origin, partner, []));
assert(!isPointVisible(origin, { x: 392, y: 730 - SIGHT_RADIUS - 1 }, []));
assert(isPointVisible(origin, origin, []));
const closed = buildWalls(new Set());
assert(isPointVisible(origin, partner, closed));
assert(!isPointVisible(origin, { x: 392, y: 600 }, closed), "A3–B3 永久實牆必須遮擋視線");
assert(!isPointVisible({ x: 350, y: 730 }, { x: 310, y: 730 }, closed), "假門後不能看見對手");
assert(isPointVisible({ x: 350, y: 730 }, { x: 310, y: 730 }, buildWalls(new Set([17]))), "真門允許視線穿過");
assert(!isPointVisible({ x: 350, y: 670 }, { x: 310, y: 670 }, buildWalls(new Set([17]))), "真門兩旁的牆仍擋住視線");
assert(!isPointVisible({ x: 0, y: 0 }, { x: 40, y: 40 }, [{ x: 20, y: 20, w: 10, h: 10 }]), "斜線視野也必須遮擋");

for (let i = 0; i < 100; i++) {
  const walls = buildWalls(new Set(generateMaze().openDoors));
  const polygon = visibilityPolygon(origin, walls);
  assert(polygon.length >= 96);
  assert(polygon.every(point => Number.isFinite(point.x) && Number.isFinite(point.y) && Math.hypot(point.x - origin.x, point.y - origin.y) <= SIGHT_RADIUS + 1e-6));
  const angles = polygon.map(point => (Math.atan2(point.y - origin.y, point.x - origin.x) + Math.PI * 2) % (Math.PI * 2));
  assert(angles.every((angle, index) => index === 0 || angle >= angles[index - 1] - 1e-6), "視野多邊形不得重複繞圈或自交");
}
console.log("OK: 捲軸鏡頭、邊界限制、平滑／減少動態、黑霧半徑、真假門與實牆視線遮擋。");
