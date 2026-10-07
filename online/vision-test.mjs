import assert from "node:assert/strict";
import { VIEW_SIZE, cameraTarget, followCamera, projectPoint } from "./public/vision.js";

assert(VIEW_SIZE < 820, "捲軸視角必須放大盤面");
assert.deepEqual(cameraTarget({ x: 0, y: 820 }), { x: 180, y: 640 });
assert.deepEqual(cameraTarget({ x: 410, y: 410 }), { x: 410, y: 410 });
assert.deepEqual(projectPoint({ x: 410, y: 410 }, { x: 410, y: 410 }, 640), { x: 320, y: 320 });
const before = { x: 250, y: 640 }, player = { x: 410, y: 570 };
const next = followCamera(before, player, 1 / 60);
assert(next.x > before.x && next.x < player.x); assert(next.y < before.y && next.y > player.y);
assert.deepEqual(followCamera(before, player, 1 / 60, true), cameraTarget(player), "減少動態效果時立即跟隨");
assert.deepEqual(followCamera(before, player, 0), before);

for (let x = -100; x <= 900; x += 25) for (let y = -100; y <= 900; y += 25) {
  const target = cameraTarget({ x, y });
  assert(target.x >= 180 && target.x <= 640 && target.y >= 180 && target.y <= 640);
  assert.deepEqual(projectPoint(target, target, 640), { x: 320, y: 320 });
}
console.log("OK: 捲軸鏡頭、放大投影、邊界限制、平滑跟隨及減少動態效果。");
