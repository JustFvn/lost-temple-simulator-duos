import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY } from "./public/geometry.js";

const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [], output = new URL("./test-artifacts/", import.meta.url);
await mkdir(output, { recursive: true });
const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
// Observe the real application socket for assertions; no production test hooks.
for (const context of [hostContext, guestContext]) await context.addInitScript(() => {
  const fillRect = CanvasRenderingContext2D.prototype.fillRect;
  CanvasRenderingContext2D.prototype.fillRect = function(x, y, w, h) {
    if (this.canvas.id === "board" && x === 0 && y === 0 && w === 820 && h === 820) {
      const { a, e, f } = this.getTransform(); window.__mapTransform = { a, e, f };
      window.__drawnPlayers = [];
    }
    return fillRect.call(this, x, y, w, h);
  };
  const arc = CanvasRenderingContext2D.prototype.arc;
  CanvasRenderingContext2D.prototype.arc = function(x, y, radius, ...rest) {
    if (this.canvas.id === "board" && radius === 12) window.__drawnPlayers?.push({ x, y });
    return arc.call(this, x, y, radius, ...rest);
  };
  let api;
  Object.defineProperty(window, "io", {
    configurable: true,
    get: () => api,
    set: original => {
      api = Object.assign((...args) => {
        const socket = original(...args), emit = socket.emit;
        socket.emit = function(event, data, ...rest) {
          if (event === "player:state") window.__position = data;
          return emit.call(this, event, data, ...rest);
        };
        socket.on("round:start", data => { window.__round = data; window.__position = null; window.__result = null; });
        socket.on("round:end", data => { window.__result = data; });
        return socket;
      }, original);
    },
  });
});
const host = await hostContext.newPage(), guest = await guestContext.newPage();
for (const page of [host, guest]) page.on("pageerror", error => errors.push(error.message));
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const visible = (page, selector) => page.locator(selector).waitFor({ state: "visible" });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "頁面不可水平溢出");
const pixelStats = page => page.evaluate(() => {
  const canvas = document.querySelector("#board"), pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  let black = 0, blue = 0, pink = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i] === 5 && pixels[i + 1] === 11 && pixels[i + 2] === 13) black++;
    if (pixels[i] === 53 && pixels[i + 1] === 167 && pixels[i + 2] === 255) blue++;
    if (pixels[i] === 255 && pixels[i + 1] === 79 && pixels[i + 2] === 129) pink++;
  }
  return { blackRatio: black / (pixels.length / 4), blue, pink };
});
async function moveTo(x, y) {
  for (const [axis, target] of [["x", x], ["y", y]]) {
    const current = (await host.evaluate(() => window.__position))[axis];
    if (Math.abs(current - target) < 10) continue;
    const increasing = current < target;
    const key = axis === "x" ? increasing ? "ArrowRight" : "ArrowLeft" : increasing ? "ArrowDown" : "ArrowUp";
    await host.keyboard.down(key);
    try {
      await host.waitForFunction(({ axis, target, increasing }) => window.__result || (window.__position && (increasing ? window.__position[axis] >= target - 8 : window.__position[axis] <= target + 8)), { axis, target, increasing }, { timeout: 4000, polling: 16 });
    } finally { await host.keyboard.up(key); }
    if (await host.evaluate(() => Boolean(window.__result))) return;
  }
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await noOverflow(host); await shot(host, "01-home-desktop.png");
  await host.locator("#createRoom").click(); assert(await host.locator("#homeView").isVisible(), "未取名不可建房");
  await host.locator("#playerName").fill("藍色冒險者"); await host.locator("#createRoom").click(); await visible(host, "#lobbyView");
  const code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  assert.equal(await guest.locator("#joinCode").inputValue(), code);
  await guest.locator("#joinRoom").click(); assert(await guest.locator("#homeView").isVisible(), "邀請連結也必須先取名");
  await shot(guest, "02-invite-mobile.png");
  await guest.locator("#playerName").fill("粉色挑戰者"); await guest.locator("#joinRoom").click(); await visible(guest, "#lobbyView");
  assert(await guest.locator("#hostSettings").evaluate(fieldset => fieldset.disabled));
  await host.locator("#proceduralMode").click(); await host.locator("#scoreToWin").fill("2"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#scoreToWin").value === "2" && document.querySelector("#proceduralMode").getAttribute("aria-pressed") === "true");
  await noOverflow(guest); await shot(host, "03-lobby-desktop.png"); await shot(guest, "04-lobby-mobile.png");
  await host.locator("#startRound").click(); await visible(host, "#gameView"); await visible(guest, "#gameView");
  await host.keyboard.down("ArrowLeft"); await host.waitForTimeout(250); await host.keyboard.up("ArrowLeft");
  assert.equal(await host.evaluate(() => window.__position), null, "倒數中不可移動");
  await shot(host, "05-countdown-desktop.png");
  await host.waitForFunction(() => window.__position); await noOverflow(guest);
  await shot(host, "06-game-desktop.png"); await shot(guest, "07-game-mobile.png");
  assert(await guest.locator(".dpad").isVisible(), "手機需提供觸控方向鍵");
  await guest.locator('[data-key="KeyD"]').scrollIntoViewIfNeeded();
  const rightButton = await guest.locator('[data-key="KeyD"]').boundingBox();
  await guest.mouse.move(rightButton.x + rightButton.width / 2, rightButton.y + rightButton.height / 2);
  await guest.mouse.down(); await guest.waitForTimeout(180); await guest.mouse.up();
  // The permanent A3–B3 wall must stop forward movement.
  await host.keyboard.down("ArrowUp"); await host.waitForTimeout(400); await host.keyboard.up("ArrowUp");
  const stopped = await host.evaluate(() => window.__position);
  assert(stopped.y >= 670, "玩家不能穿過 A3–B3 實牆");
  await moveTo(410, 730);
  const round = await host.evaluate(() => window.__round);
  assert.equal(round.layoutId, null); assert.deepEqual(round, await guest.evaluate(() => window.__round));
  const paths = allPaths(new Set(round.openDoors)); assert.equal(paths.length, 2);
  for (const room of paths[0].slice(1)) await moveTo(roomCX(room), roomCY(room));
  await visible(host, "#resultInfo"); await visible(guest, "#resultInfo");
  assert.equal((await host.evaluate(() => window.__result)).winner, 0);
  assert.equal(await host.locator("#p1Score").textContent(), "1");
  assert.equal(await guest.locator("#p1Score").textContent(), "1");
  assert(await guest.locator("#nextRound").isHidden());
  await shot(host, "08-result-desktop.png"); await shot(guest, "09-result-mobile.png");
  await host.locator("#toggleRoutes").click(); assert.equal(await host.locator("#toggleRoutes").textContent(), "查看兩條路線");
  await host.locator("#nextRound").click(); await host.waitForFunction(id => window.__round.roundId !== id, round.roundId);
  assert.equal((await host.evaluate(() => window.__round)).roundNumber, 2);
  await host.waitForFunction(() => window.__position);
  const second = await host.evaluate(() => window.__round);
  const secondPath = allPaths(new Set(second.openDoors))[0];
  for (const room of secondPath.slice(1)) await moveTo(roomCX(room), roomCY(room));
  await visible(host, "#resultInfo");
  assert.equal(await host.locator("#resultTitle").textContent(), "你贏得整場！");
  assert.equal(await host.locator("#nextRound").textContent(), "再來一場 →");
  await shot(host, "10-match-winner.png");
  await host.locator("#returnLobby").click(); await visible(host, "#lobbyView");
  await host.locator("#viewMode").check();
  await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#viewMode").checked && document.querySelector("#scoreToWin").value === "1");
  await shot(host, "11-scroll-settings.png");
  await host.locator("#startRound").click();
  await host.waitForFunction(() => window.__round.settings.viewMode === "scroll" && window.__position);
  await host.locator("#countdown").waitFor({ state: "hidden" });
  const scrollRound = await host.evaluate(() => window.__round);
  assert.deepEqual(scrollRound.scores, [0, 0, 0, 0]);
  assert.equal(await host.locator("#board").getAttribute("data-view"), "scroll");
  assert.equal(await guest.locator("#board").getAttribute("data-view"), "scroll");
  const initialTransform = await host.evaluate(() => window.__mapTransform);
  assert(Math.abs(initialTransform.a - await host.locator("#board").evaluate(canvas => canvas.width / 360)) < 1e-6);
  const initialPixels = await pixelStats(host);
  assert(initialPixels.blackRatio < .001 && initialPixels.blue > 10 && initialPixels.pink > 10, "捲軸不可有黑霧遮罩，近處的雙方都可見");
  const behindWall = await host.locator("#board").evaluate(canvas => {
    const point = { x: (392 - 392 + 180) * canvas.width / 360, y: (600 - 640 + 180) * canvas.width / 360 };
    return [...canvas.getContext("2d").getImageData(Math.round(point.x), Math.round(point.y), 1, 1).data];
  });
  assert.deepEqual(behindWall, [16, 21, 15, 255], "實牆後仍顯示房間地板，不是黑霧遮罩");
  await shot(host, "12-scroll-start-desktop.png"); await shot(guest, "13-scroll-start-mobile.png");
  const scrollPath = allPaths(new Set(scrollRound.openDoors))[0];
  for (const room of scrollPath.slice(1, 3)) await moveTo(roomCX(room), roomCY(room));
  await host.waitForTimeout(250);
  const movedTransform = await host.evaluate(() => window.__mapTransform);
  assert(Math.abs(movedTransform.e - initialTransform.e) + Math.abs(movedTransform.f - initialTransform.f) > 50, "鏡頭必須實際隨角色捲動");
  const movedPixels = await pixelStats(host);
  assert(movedPixels.blue > 10 && movedPixels.blackRatio < .001, "鏡頭捲動後自己可見且沒有黑霧遮罩");
  const drawn = await host.evaluate(() => window.__drawnPlayers);
  assert.equal(drawn.length, 2, "不再使用視線或距離隱藏對手，只由鏡頭裁切畫面");
  await shot(host, "14-scroll-scrolling-desktop.png"); await shot(guest, "15-scroll-opponent-hidden-mobile.png");
  await noOverflow(guest);
  for (const room of scrollPath.slice(3)) await moveTo(roomCX(room), roomCY(room));
  await visible(host, "#resultInfo");
  await host.waitForFunction(() => document.querySelector("#board").dataset.view === "overview");
  assert(await host.locator("#scrollBadge").isHidden(), "結算揭曉時恢復全圖");
  await shot(host, "16-scroll-result.png");
  await host.locator("#toggleRoutes").click();
  await host.waitForFunction(() => document.querySelector("#board").dataset.view === "scroll");
  await host.locator("#toggleRoutes").click();
  await host.waitForFunction(() => document.querySelector("#board").dataset.view === "overview");
  await host.locator("#returnLobby").click();
  await host.locator("#viewMode").uncheck();
  await guest.waitForFunction(() => !document.querySelector("#viewMode").checked);
  await host.locator("#startRound").click(); await visible(host, "#gameView");
  await host.waitForFunction(() => document.querySelector("#board").dataset.view === "overview" && window.__round.settings.viewMode === "standard");
  await guest.locator("#leaveRoom").click(); await visible(guest, "#homeView"); await visible(host, "#lobbyView");
  assert.equal(await host.locator("#seatCount").textContent(), "1 / 4");
  assert.deepEqual(errors, [], "瀏覽器不得有 JavaScript 錯誤");
  console.log("OK: 桌機／手機雙人通關、捲軸無黑霧遮罩、牆後房間可見、雙方正常繪製、鏡頭跟隨、模式同步與結算全圖切換。");
} finally { await browser.close(); }
