import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY } from "./public/geometry.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const contexts = [await browser.newContext({ viewport: { width: 1440, height: 1000 } }), await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })];
const errors = [], output = new URL("./test-artifacts/", import.meta.url); await mkdir(output, { recursive: true });
for (const context of contexts) await context.addInitScript(() => {
  const fill = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
    if (this.canvas.id === "board" && x === -17 && y === 11 && w === 34 && h === 4) window.__crownColor = this.fillStyle;
    return fill.call(this, x, y, w, h);
  };
  const stroke = CanvasRenderingContext2D.prototype.stroke;
  CanvasRenderingContext2D.prototype.stroke = function(...args) {
    if (this.canvas.id === "board" && this.strokeStyle === "#9ae6ce") window.__trailSeen = true;
    return stroke.apply(this, args);
  };
  let api;
  Object.defineProperty(window, "io", { configurable: true, get: () => api, set: original => {
    api = Object.assign((...args) => {
      const socket = original(...args), emit = socket.emit;
      socket.emit = function(event, data, ...rest) {
        if (event === "player:state") window.__position = data;
        return emit.call(this, event, data, ...rest);
      };
      socket.on("round:start", data => { window.__round = data; window.__position = null; window.__result = null; window.__progress = null; });
      socket.on("route:progress", data => { window.__progress = data; });
      socket.on("round:end", data => { window.__result = data; });
      return socket;
    }, original);
  } });
});
const host = await contexts[0].newPage(), guest = await contexts[1].newPage();
for (const page of [host, guest]) page.on("pageerror", error => errors.push(error.message));
const visible = (page, selector) => page.locator(selector).waitFor({ state: "visible" });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "手機不得水平溢出");
async function moveTo(page, room) {
  for (const [axis, target] of [["x", roomCX(room)], ["y", roomCY(room)]]) {
    const current = (await page.evaluate(() => window.__position))[axis];
    if (Math.abs(current - target) < 10) continue;
    const increasing = current < target;
    const key = axis === "x" ? increasing ? "ArrowRight" : "ArrowLeft" : increasing ? "ArrowDown" : "ArrowUp";
    await page.keyboard.down(key);
    try {
      await page.waitForFunction(({ axis, target, increasing }) => window.__result || (window.__position && (increasing ? window.__position[axis] >= target - 8 : window.__position[axis] <= target + 8)), { axis, target, increasing }, { timeout: 5000, polling: 16 });
    } finally { await page.keyboard.up(key); }
    if (await page.evaluate(() => Boolean(window.__result))) return;
  }
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("全路線房主"); await host.locator("#createRoom").click(); await visible(host, "#lobbyView");
  const code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  await guest.locator("#playerName").fill("手機探索者"); await guest.locator("#joinRoom").click(); await visible(guest, "#lobbyView");
  await host.locator("#proceduralMode").click(); await host.locator("#doorMode").selectOption("coverage");
  assert(await host.locator("#proceduralMode").isDisabled()); assert.equal(await host.locator("#officialMode").getAttribute("aria-pressed"), "true");
  await host.locator("#layoutMode").selectOption("fixed"); await host.locator("#fixedLayout").fill("12"); await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "coverage" && document.querySelector("#officialMode").getAttribute("aria-pressed") === "true");
  await shot(host, "coverage-lobby-desktop.png");
  for (const [index, player] of [host, guest].entries()) {
    const other = player === host ? guest : host;
    if (index) { await host.locator("#returnLobby").click(); await host.locator("#viewMode").check(); }
    await host.locator("#startRound").click(); await visible(player, "#gameView");
    await player.waitForFunction(() => window.__position);
    assert(await player.locator("#coveragePanel").isVisible());
    assert.equal(await player.evaluate(() => window.__round.layoutId), 12);
    await player.waitForFunction(() => window.__crownColor === "#8b9992");
    assert.equal(await player.locator("#coverageProgress").evaluate(p => p.value), 0);
    if (index) {
      assert.equal(await player.locator("#board").getAttribute("data-view"), "scroll");
      const button = player.locator('[data-key="KeyD"]');
      const before = await player.evaluate(() => window.__position.x);
      await button.hover(); await player.mouse.down(); await player.waitForTimeout(120); await player.mouse.up();
      await player.waitForFunction(x => window.__position.x > x + 10, before);
    }
    const round = await player.evaluate(() => window.__round), paths = allPaths(new Set(round.openDoors));
    for (const room of paths[0]) await moveTo(player, room);
    assert.equal(await player.evaluate(() => window.__result), null, "第一條路抵達 E3 不能直接獲勝");
    assert(await player.locator("#resultInfo").isHidden());
    assert.match(await player.locator("#coverageStatus").textContent(), /王冠鎖定/);
    const first = await player.evaluate(() => window.__progress);
    assert(first.completed > 0 && first.completed < first.total);
    assert.equal(await other.locator("#coverageProgress").evaluate(p => p.value), 0, "共享探門不會完成對手進度");
    await player.waitForFunction(() => window.__trailSeen);
    await shot(player, index ? "coverage-locked-mobile-scroll.png" : "coverage-locked-desktop.png"); await noOverflow(guest);
    for (const room of [...paths[1]].reverse()) await moveTo(player, room);
    await player.waitForFunction(() => window.__progress?.ready);
    assert.equal(await player.evaluate(() => window.__result), null, "走完仍要前往 E3");
    await player.waitForFunction(() => window.__crownColor === "#e3b565");
    assert.match(await player.locator("#coverageStatus").textContent(), /王冠已解鎖/);
    await shot(player, index ? "coverage-unlocked-mobile-scroll.png" : "coverage-unlocked-desktop.png");
    for (const room of paths[0]) { await moveTo(player, room); if (await player.evaluate(() => window.__result)) break; }
    await visible(player, "#resultInfo"); await visible(other, "#resultInfo");
    assert.equal(await player.evaluate(() => window.__result.winner), index);
    assert.match(await player.locator("#resultTitle").textContent(), /你贏得整場/);
    await shot(player, index ? "coverage-result-mobile.png" : "coverage-result-desktop.png"); await noOverflow(guest);
  }
  await host.locator("#returnLobby").click(); await host.locator("#doorMode").selectOption("normal");
  assert(await host.locator("#proceduralMode").isEnabled()); await host.locator("#proceduralMode").click();
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "normal" && document.querySelector("#proceduralMode").getAttribute("aria-pressed") === "true");
  await host.locator("#startRound").click(); await visible(host, "#gameView"); assert(await host.locator("#coveragePanel").isHidden());
  await guest.locator("#leaveRoom").click(); await visible(host, "#lobbyView");
  assert.deepEqual(errors, []);
  console.log("OK: 桌機／手機官方鎖定、實際走兩條路、未完成王冠不凍結、個人足跡／進度、皇冠解鎖與勝利、捲軸及觸控、回合清零、切換玩法隱藏進度與生成地圖解鎖。");
} finally { await browser.close(); }
