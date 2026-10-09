import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const desktop = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
await mobile.addInitScript(() => {
  let api;
  Object.defineProperty(window, "io", { configurable: true, get: () => api, set: original => {
    api = Object.assign((...args) => {
      const socket = original(...args), emit = socket.emit;
      socket.emit = function(event, data, ...rest) { if (event === "player:state") window.__position = data; return emit.call(this, event, data, ...rest); };
      socket.on("round:start", data => { window.__round = data; window.__position = null; window.__resets = []; });
      socket.on("player:reset", data => { if (data.slot === 1) { window.__position = data; window.__resets.push(data); } });
      return socket;
    }, original);
  } });
});
const host = await desktop.newPage(), guest = await mobile.newPage(), errors = [];
for (const page of [host, guest]) page.on("pageerror", e => errors.push(e.message));
const cdp = await mobile.newCDPSession(guest), output = new URL("./test-artifacts/", import.meta.url); await mkdir(output, { recursive: true });
const visible = (page, selector) => page.locator(selector).waitFor({ state: "visible" });
const button = key => guest.locator(`[data-key="${key}"]`);
const pressed = key => guest.waitForFunction(key => document.querySelector(`[data-key="${key}"]`).classList.contains("pressed"), key, { timeout: 2000 });
const position = () => guest.evaluate(() => window.__position);
async function touch(type, key) {
  let points = [];
  if (type === "touchStart" || type === "touchMove") {
    const rect = await (key ? button(key) : guest.locator(".dpad")).boundingBox();
    points = [{ x: key ? rect.x + rect.width / 2 : rect.x + rect.width + 12, y: rect.y + rect.height / 2, id: 1 }];
  }
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points });
}
async function direction(key, type = "touchMove") {
  const before = await position(), axis = ["KeyA", "KeyD"].includes(key) ? "x" : "y", sign = ["KeyW", "KeyA"].includes(key) ? -1 : 1;
  await touch(type, key); await pressed(key);
  await guest.waitForFunction(({ axis, sign, before }) => (window.__position[axis] - before[axis]) * sign > 12, { axis, sign, before }, { timeout: 2000 });
  assert.equal(await guest.locator(".dpad .pressed").count(), 1);
}
async function stopped() {
  await guest.waitForFunction(() => document.querySelectorAll(".dpad .pressed").length === 0, null, { timeout: 2000 });
  await guest.waitForTimeout(120); const before = await position(); await guest.waitForTimeout(120);
  const after = await position(); assert.equal(after.x, before.x); assert.equal(after.y, before.y);
}
let code;
async function start(mode = "normal") {
  if (await guest.locator("#gameView").isVisible()) {
    await guest.locator("#leaveRoom").click(); await visible(host, "#lobbyView"); await visible(guest, "#homeView");
    await guest.locator("#joinCode").fill(code); await guest.locator("#joinRoom").click(); await visible(guest, "#lobbyView");
  }
  await host.locator("#doorMode").selectOption(mode);
  await guest.waitForFunction(mode => document.querySelector("#doorMode").value === mode, mode);
  await host.locator("#startRound").click(); await visible(guest, "#gameView"); await guest.waitForFunction(() => window.__position);
  await guest.locator(".dpad").scrollIntoViewIfNeeded();
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("觸控房主"); await host.locator("#createRoom").click(); await visible(host, "#lobbyView");
  code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  await guest.locator("#playerName").fill("滑動手機玩家"); await guest.locator("#joinRoom").click(); await visible(guest, "#lobbyView");
  await host.locator("#layoutMode").selectOption("fixed"); await host.locator("#fixedLayout").fill("12"); await host.locator("#fixedLayout").press("Tab");
  await start();
  const rects = await Promise.all(["KeyW", "KeyA", "KeyD", "KeyS"].map(async key => ({ key, ...await button(key).boundingBox() })));
  for (const rect of rects) { assert.equal(rect.width, 56); assert.equal(rect.height, 56); }
  const [up, left, right, down] = rects;
  assert.equal(left.y, right.y); assert.equal(up.x, down.x); assert.equal(left.y + 28, (up.y + down.y) / 2 + 28, "左右位於上下之間同一高度");
  await direction("KeyW", "touchStart"); await direction("KeyD"); await direction("KeyS"); await direction("KeyA");
  await touch("touchMove", null); await stopped(); await direction("KeyW");
  await guest.screenshot({ path: fileURLToPath(new URL("touch-cross-mobile.png", output)), fullPage: true });
  await touch("touchEnd"); await stopped();
  // Screenshot capture may keep the held Up gesture moving until the top wall.
  // Re-center vertically so the mixed-input assertion tests input, not a wall.
  if ((await position()).y < 715) {
    await touch("touchStart", "KeyS"); await guest.waitForFunction(() => window.__position.y >= 720); await touch("touchEnd"); await stopped();
  }
  await guest.locator("#board").evaluate(canvas => canvas.focus({ preventScroll: true }));
  // Releasing touch must not cancel the same key held on a keyboard.
  await direction("KeyD", "touchStart"); await guest.keyboard.down("KeyD"); await touch("touchEnd");
  const mixed = await position(); await guest.waitForFunction(x => window.__position.x > x + 12, mixed.x);
  await guest.keyboard.up("KeyD"); await stopped();
  await direction("KeyA", "touchStart"); await touch("touchCancel"); await stopped();
  assert(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await start("math"); await touch("touchStart", "KeyA"); await visible(guest, "#mathChallenge");
  await guest.waitForFunction(() => !document.querySelector("#mathAnswer").disabled);
  assert.equal(await guest.locator(".dpad .pressed").count(), 0, "數學彈窗清除觸控輸入");
  const [, a, op, b] = (await guest.locator("#mathQuestion").textContent()).match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  const answer = op === "+" ? +a + +b : op === "−" ? +a - +b : op === "×" ? +a * +b : +a / +b;
  await guest.locator("#mathAnswer").fill(String(answer)); await guest.locator("#mathAnswer").press("Enter"); await guest.locator("#mathChallenge").waitFor({ state: "hidden" });
  await guest.locator(".dpad").scrollIntoViewIfNeeded(); await touch("touchMove", "KeyD"); await stopped(); await touch("touchEnd");
  await direction("KeyD", "touchStart"); await touch("touchEnd"); await stopped();
  await start("traffic");
  await guest.waitForFunction(() => document.querySelector("#trafficSignal").dataset.phase === "red" && parseFloat(document.querySelector("#trafficCountdown").textContent) > .8, null, { timeout: 12000 });
  await touch("touchStart", "KeyD"); await guest.waitForFunction(() => window.__resets.length === 1);
  for (const key of ["KeyW", "KeyA", "KeyS", "KeyD"]) await touch("touchMove", key);
  await stopped(); assert.equal((await position()).x, 428); assert.equal((await position()).y, 730);
  await guest.waitForFunction(() => document.querySelector("#trafficSignal").dataset.phase === "green", null, { timeout: 7000 });
  await touch("touchMove", "KeyD"); await stopped(); assert.equal(await guest.evaluate(() => window.__resets.length), 1);
  await touch("touchEnd"); await direction("KeyD", "touchStart"); await touch("touchEnd"); await stopped();
  await guest.locator("#leaveRoom").click(); await visible(host, "#lobbyView"); assert.deepEqual(errors, []);
  console.log("OK: 真實手機觸控四鍵 56×56 與十字對齊、按住滑動切換、滑出／放開／取消停止、鍵盤觸控混用、數學彈窗清理、紅燈手勢阻擋到放開、無橫向溢出與 JS 錯誤。");
} catch (error) {
  await guest.screenshot({ path: fileURLToPath(new URL("touch-failure.png", output)), fullPage: true }); throw error;
} finally { await browser.close(); }
