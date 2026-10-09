import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY, BOARD } from "./public/geometry.js";
import { rotateVector } from "./public/rotation.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const contexts = [await browser.newContext({ viewport: { width: 1440, height: 1000 } }), await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })];
for (const context of contexts) await context.addInitScript(() => {
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
    if (this.canvas.id === "board" && x === 0 && y === 0 && w === 820 && h === 820) {
      const { a, b, c, d, e, f } = this.getTransform(); window.__matrix = { a, b, c, d, e, f };
      const degrees = Number(this.canvas.dataset.rotation); if (Number.isFinite(degrees)) window.__quadrants?.add(Math.floor(degrees / 90));
    }
    return fill.call(this, x, y, w, h);
  };
  let api;
  Object.defineProperty(window, "io", { configurable: true, get: () => api, set: original => {
    api = Object.assign((...args) => {
      const socket = original(...args), emit = socket.emit;
      socket.emit = function(event, data, ...rest) { if (event === "player:state") window.__position = data; return emit.call(this, event, data, ...rest); };
      socket.on("round:start", data => { window.__round = data; window.__position = null; window.__result = null; window.__quadrants = new Set(); });
      socket.on("round:end", data => { window.__result = data; }); return socket;
    }, original);
  } });
});
const host = await contexts[0].newPage(), guest = await contexts[1].newPage(), cdp = await contexts[1].newCDPSession(guest);
const errors = [], output = new URL("./test-artifacts/", import.meta.url); await mkdir(output, { recursive: true });
for (const page of [host, guest]) page.on("pageerror", e => errors.push(e.message));
const visible = (page, selector) => page.locator(selector).waitFor({ state: "visible" });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
const held = new Set();
async function keys(next) {
  for (const key of [...held]) if (!next.has(key)) { await host.keyboard.up(key); held.delete(key); }
  for (const key of next) if (!held.has(key)) { await host.keyboard.down(key); held.add(key); }
}
async function walkPath() {
  await host.locator("#board").evaluate(c => c.focus({ preventScroll: true }));
  const round = await host.evaluate(() => window.__round), path = allPaths(new Set(round.openDoors))[0];
  try {
    for (const room of path) {
      const until = Date.now() + 7000;
      for (;;) {
        const state = await host.evaluate(() => ({ position: window.__position, result: window.__result, angle: Number(document.querySelector("#board").dataset.rotation) * Math.PI / 180 }));
        if (state.result) return;
        const dx = roomCX(room) - state.position.x, dy = roomCY(room) - state.position.y, distance = Math.hypot(dx, dy);
        if (distance < 14) { await keys(new Set()); break; }
        if (Date.now() > until) throw new Error(`旋轉中無法走到房間 ${room}: ${JSON.stringify(state.position)}`);
        const vector = rotateVector(dx, dy, state.angle), next = new Set();
        if (Math.abs(vector.x) > distance * .382) next.add(vector.x > 0 ? "ArrowRight" : "ArrowLeft");
        if (Math.abs(vector.y) > distance * .382) next.add(vector.y > 0 ? "ArrowDown" : "ArrowUp");
        await keys(next); await host.waitForTimeout(35);
      }
    }
  } finally { await keys(new Set()); }
  await visible(host, "#resultInfo");
}
async function touch(type, key) {
  const rect = key ? await guest.locator(`[data-key="${key}"]`).boundingBox() : null;
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: rect ? [{ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, id: 1 }] : [] });
}
async function touchDirection(key, type) {
  await touch(type, key);
  await guest.waitForFunction(key => document.querySelector(`[data-key="${key}"]`).classList.contains("pressed"), key);
  // Wait for one position heartbeat from the new direction; the previous
  // direction's last packet can otherwise contaminate a sliding assertion.
  await guest.waitForTimeout(70);
  const before = await guest.evaluate(() => ({ ...window.__position, angle: Number(document.querySelector("#board").dataset.rotation) * Math.PI / 180 }));
  await guest.waitForFunction(before => Math.hypot(window.__position.x - before.x, window.__position.y - before.y) > 8, before, { timeout: 2000 });
  const after = await guest.evaluate(() => ({ ...window.__position, angle: Number(document.querySelector("#board").dataset.rotation) * Math.PI / 180 }));
  const delta = rotateVector(after.x - before.x, after.y - before.y, (before.angle + after.angle) / 2);
  if (key === "KeyD") assert(delta.x > 7 && Math.abs(delta.y) < 4, `手機右鍵按螢幕右方向移動：${JSON.stringify(delta)}`);
  else assert(delta.y < -7 && Math.abs(delta.x) < 4, `滑到上鍵按螢幕上方向移動：${JSON.stringify(delta)}`);
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("旋轉冒險者"); await host.locator("#createRoom").click(); await visible(host, "#lobbyView");
  const code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  await guest.locator("#playerName").fill("手機羅盤手"); await guest.locator("#joinRoom").click(); await visible(guest, "#lobbyView");
  await host.locator("#doorMode").selectOption("rotate"); await host.locator("#layoutMode").selectOption("fixed");
  await host.locator("#fixedLayout").fill("12"); await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "rotate");
  await host.locator("#startRound").click(); await visible(host, "#gameView"); await visible(guest, "#gameView");
  for (const page of [host, guest]) { assert(await page.locator("#rotationSignal").isVisible()); assert.equal(Number(await page.locator("#board").getAttribute("data-rotation")), 0); }
  await host.waitForFunction(() => window.__position);
  await host.waitForFunction(() => Number(document.querySelector("#board").dataset.rotation) >= 43);
  for (const page of [host, guest]) {
    const corners = await page.evaluate(board => {
      const m = window.__matrix, canvas = document.querySelector("#board");
      return [0, board].flatMap(x => [0, board].map(y => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f, size: canvas.width })));
    }, BOARD);
    assert(corners.every(p => p.x >= -1e-5 && p.x <= p.size + 1e-5 && p.y >= -1e-5 && p.y <= p.size + 1e-5), "45° 旋轉四角不能裁切");
    await noOverflow(page);
  }
  const angles = await Promise.all([host, guest].map(page => page.evaluate(() => Number(document.querySelector("#board").dataset.rotation))));
  assert(Math.abs(angles[0] - angles[1]) < 2, "兩端同步旋轉角度");
  await shot(host, "rotation-45-desktop.png"); await shot(guest, "rotation-45-mobile.png");
  await host.waitForFunction(() => window.__quadrants.size === 4 && Number(document.querySelector("#board").dataset.rotation) < 8, null, { timeout: 30000 });
  await guest.locator(".dpad").scrollIntoViewIfNeeded(); await touchDirection("KeyD", "touchStart"); await touchDirection("KeyW", "touchMove"); await touch("touchEnd");
  await guest.waitForFunction(() => document.querySelectorAll(".dpad .pressed").length === 0);
  await walkPath(); await visible(guest, "#resultInfo");
  assert.equal(await host.evaluate(() => window.__result.matchWinner), 0);
  assert(await host.locator("#rotationSignal").isHidden()); assert.equal(await host.locator("#board").getAttribute("data-rotation"), null);
  await shot(host, "rotation-result-desktop.png");
  await host.locator("#returnLobby").click(); await host.locator("#proceduralMode").click(); await host.locator("#viewMode").check();
  await guest.emulateMedia({ reducedMotion: "reduce" });
  await guest.waitForFunction(() => document.querySelector("#viewMode").checked && document.querySelector("#proceduralMode").getAttribute("aria-pressed") === "true");
  await host.locator("#startRound").click(); await visible(host, "#gameView"); await host.waitForFunction(() => window.__position);
  assert.equal(await host.locator("#board").getAttribute("data-view"), "scroll");
  assert.match(await guest.locator("#rotationHint").textContent(), /減少動態/);
  assert.equal(Number(await guest.locator("#board").getAttribute("data-rotation")), 0);
  await guest.waitForFunction(() => Number(document.querySelector("#board").dataset.rotation) === 90, null, { timeout: 10000 });
  await guest.waitForTimeout(200); assert.equal(Number(await guest.locator("#board").getAttribute("data-rotation")), 90, "減少動態採固定 90° 階段，不持續動畫");
  await shot(host, "rotation-scroll-desktop.png"); await shot(guest, "rotation-reduced-mobile.png");
  await walkPath(); await visible(guest, "#resultInfo"); await noOverflow(guest);
  await host.locator("#returnLobby").click(); await host.locator("#doorMode").selectOption("normal"); await host.locator("#startRound").click(); await visible(host, "#gameView");
  assert(await host.locator("#rotationSignal").isHidden()); assert.equal(await host.locator("#board").getAttribute("data-rotation"), null);
  await guest.locator("#leaveRoom").click(); await visible(host, "#lobbyView"); assert.deepEqual(errors, []);
  console.log("OK: 桌機／手機同步完整 360° 旋轉、45° 四角完整、手機滑動以螢幕方向移動、真實鍵盤官方／捲軸生成通關、減少動態 90° 轉向、結算／模式切換清除旋轉。");
} catch (error) {
  await shot(host, "rotation-failure-desktop.png"); await shot(guest, "rotation-failure-mobile.png"); throw error;
} finally { await keys(new Set()); await browser.close(); }
