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
  await host.locator("#nextRound").click(); await host.waitForFunction(id => window.__round.roundId !== id, second.roundId);
  assert.deepEqual((await host.evaluate(() => window.__round)).scores, [0, 0]);
  await guest.locator("#leaveRoom").click(); await visible(guest, "#homeView"); await visible(host, "#lobbyView");
  assert.equal(await host.locator("#seatCount").textContent(), "1 / 2");
  assert.deepEqual(errors, [], "瀏覽器不得有 JavaScript 錯誤");
  console.log("OK: 桌機／手機獨立 GUI、邀請取名、自訂設定同步、倒數禁移動、鍵盤真實通關、雙人結算、下一回合與離房。截圖：test-artifacts/");
} finally { await browser.close(); }
