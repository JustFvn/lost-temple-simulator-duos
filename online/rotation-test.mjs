import assert from "node:assert/strict";
import { BOARD } from "./public/geometry.js";
import { VIEW_SIZE } from "./public/vision.js";
import { ROTATION_PERIOD_MS, rotationState, rotateVector, screenToWorld, projectRotatedPoint } from "./public/rotation.js";
const schedule = { periodMs: ROTATION_PERIOD_MS };
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
for (const [elapsed, degrees] of [[-10, 0], [0, 0], [4000, 90], [8000, 180], [12000, 270], [16000, 0], [20000, 90]]) near(rotationState(schedule, elapsed).degrees, degrees);
for (let elapsed = 0; elapsed < 100000; elapsed += 117) {
  const state = rotationState(schedule, elapsed), reduced = rotationState(schedule, elapsed, true);
  assert(state.degrees >= 0 && state.degrees < 360 && state.remaining > 0);
  assert([0, 90, 180, 270].includes(reduced.degrees));
  near(rotationState(schedule, elapsed + ROTATION_PERIOD_MS * 1000).angle, state.angle);
}
for (let degrees = 0; degrees < 360; degrees++) {
  const angle = degrees * Math.PI / 180;
  for (const [x, y] of [[0, -1], [1, 0], [0, 1], [-1, 0], [1, 1]]) {
    const world = screenToWorld(x, y, angle), back = rotateVector(world.x, world.y, angle);
    near(back.x, x); near(back.y, y); near(Math.hypot(world.x, world.y), Math.hypot(x, y));
  }
  for (const camera of [null, { x: 180, y: 640 }, { x: 410, y: 410 }]) {
    const center = camera || { x: BOARD / 2, y: BOARD / 2 }, half = (camera ? VIEW_SIZE : BOARD) / 2;
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const point = projectRotatedPoint({ x: center.x + sx * half, y: center.y + sy * half }, camera, 640, angle);
      assert(point.x >= -1e-8 && point.x <= 640 + 1e-8 && point.y >= -1e-8 && point.y <= 640 + 1e-8, "每個角度的全圖／捲軸視窗四角都須可見");
    }
  }
}
console.log("OK: 每 4 秒 90°／16 秒 360° 同步旋轉、完整循環、減少動態 90° 轉向、螢幕方向控制與速度不變、360 種角度的全圖／捲軸四角不裁切。");
