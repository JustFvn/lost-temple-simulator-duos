import assert from "node:assert/strict";
import { createDpad } from "./public/touch-controls.js";
const rects = { KeyW: [61, 0], KeyA: [0, 61], KeyD: [122, 61], KeyS: [61, 122] };
const buttons = Object.entries(rects).map(([key, [left, top]]) => ({
  dataset: { key }, pressed: false,
  getBoundingClientRect: () => ({ left, top, right: left + 56, bottom: top + 56 }),
  classList: { toggle(_, value) { buttons.find(b => b.dataset.key === key).pressed = value; } },
}));
const handlers = new Map(), captures = new Set(); let enabled = true, held = new Set();
const pad = { querySelectorAll: () => buttons, addEventListener: (type, handler) => handlers.set(type, handler), setPointerCapture: id => captures.add(id), hasPointerCapture: id => captures.has(id), releasePointerCapture: id => captures.delete(id) };
const controls = createDpad(pad, { canPress: () => enabled, onChange: keys => { held = keys; } });
const event = (type, key, id = 1) => {
  const [x, y] = rects[key] || [-100, -100];
  handlers.get(type)({ pointerId: id, button: 0, clientX: x + 28, clientY: y + 28, preventDefault() {} });
  if (["pointerup", "pointercancel", "lostpointercapture"].includes(type)) captures.delete(id);
};
event("pointerdown", "KeyW"); assert.deepEqual([...held], ["KeyW"]);
for (const key of ["KeyD", "KeyS", "KeyA", "KeyW"]) {
  event("pointermove", key); assert.deepEqual([...held], [key], "不放開即可切換方向");
  assert.equal(buttons.filter(b => b.pressed).length, 1);
}
event("pointermove", null); assert.equal(held.size, 0, "滑出按鈕停止移動");
event("pointermove", "KeyD"); assert(held.has("KeyD"), "滑回按鈕恢復移動");
event("pointerup", "KeyD"); assert.equal(held.size, 0);
event("pointermove", "KeyA"); assert.equal(held.size, 0, "未按住的移入不會移動");
event("pointerdown", "KeyA", 1); event("pointerdown", "KeyA", 2);
event("pointerup", "KeyA", 1); assert(held.has("KeyA"), "同一按鈕多指放開一指仍按住");
event("pointermove", "KeyW", 3); assert(!held.has("KeyW"), "忽略未捕捉手指");
event("pointercancel", "KeyA", 2); assert.equal(held.size, 0);
event("pointerdown", "KeyD"); controls.blockUntilRelease();
for (const key of ["KeyW", "KeyA", "KeyS", "KeyD"]) event("pointermove", key);
assert.equal(held.size, 0, "紅燈傳送後滑到其他按鈕不能繼續移動");
event("pointerup", "KeyD"); event("pointerdown", "KeyD"); assert(held.has("KeyD"));
controls.clear(); assert.equal(held.size, 0); assert.equal(captures.size, 0);
event("pointermove", "KeyD"); assert.equal(held.size, 0, "離房／開題後舊手勢不恢復");
enabled = false; event("pointerdown", "KeyW"); assert.equal(held.size, 0);
enabled = true; event("pointerdown", "KeyW"); event("lostpointercapture", "KeyW"); assert.equal(held.size, 0);
console.log("OK: 按住滑動切換四方向、滑出停止／滑回恢復、多指獨立、放開／取消／失焦停止、紅燈阻擋到放開、答題／離房清理。");
