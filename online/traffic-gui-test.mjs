import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY, GAPS } from "./public/geometry.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const contexts = [await browser.newContext({ viewport: { width: 1440, height: 1000 } }), await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })];
for (const [slot, context] of contexts.entries()) await context.addInitScript(slot => {
  let api;
  Object.defineProperty(window, "io", { configurable: true, get: () => api, set: original => {
    api = Object.assign((...args) => {
      const socket = original(...args), emit = socket.emit;
      socket.emit = function(event, data, ...rest) {
        if (event === "player:state") window.__position = data;
        if (event === "door:discover") window.__discoveries.push(data.doorId);
        return emit.call(this, event, data, ...rest);
      };
      socket.on("round:start", data => { window.__round = data; window.__position = null; window.__resets = []; window.__discoveries = []; window.__result = null; });
      socket.on("player:reset", data => { window.__resets.push(data); if (data.slot === slot) window.__position = data; });
      socket.on("round:end", data => { window.__result = data; });
      return socket;
    }, original);
  } });
}, slot);
const host = await contexts[0].newPage(), guest = await contexts[1].newPage(), errors = [];
for (const page of [host, guest]) page.on("pageerror", error => errors.push(error.message));
const output = new URL("./test-artifacts/", import.meta.url); await mkdir(output, { recursive: true });
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
const phase = (page, value, seconds = 0) => page.waitForFunction(({ value, seconds }) => document.querySelector("#trafficSignal").dataset.phase === value && parseFloat(document.querySelector("#trafficCountdown").textContent) >= seconds, { value, seconds }, { timeout: 15000 });
async function start() {
  const previous = await host.evaluate(() => window.__round?.roundId);
  await host.locator("#startRound").click();
  await host.waitForFunction(previous => window.__round && window.__round.roundId !== previous && window.__position, previous);
  await host.locator("#countdown").waitFor({ state: "hidden" });
}
async function moveTo(x, y) {
  for (const [axis, target] of [["x", x], ["y", y]]) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const current = (await host.evaluate(() => window.__position))[axis];
      if (Math.abs(current - target) < 12) break;
      await phase(host, "green", .8);
      const increasing = current < target, key = axis === "x" ? increasing ? "ArrowRight" : "ArrowLeft" : increasing ? "ArrowDown" : "ArrowUp";
      await host.locator("#board").focus(); await host.keyboard.down(key);
      try {
        await host.waitForFunction(({ axis, target, increasing }) => window.__result || document.querySelector("#trafficSignal").dataset.phase !== "green" || (increasing ? window.__position[axis] >= target - 8 : window.__position[axis] <= target + 8), { axis, target, increasing }, { timeout: 6000 });
      } finally { await host.keyboard.up(key); }
      if (await host.evaluate(() => Boolean(window.__result))) return;
      if (attempt === 11) throw new Error(`無法抵達 ${axis}=${target}`);
    }
  }
}
async function finishPath() {
  const round = await host.evaluate(() => window.__round), path = allPaths(new Set(round.openDoors))[0];
  for (const room of path) await moveTo(roomCX(room), roomCY(room));
  await host.locator("#resultInfo").waitFor({ state: "visible" });
  assert.equal((await host.evaluate(() => window.__result)).matchWinner, 0);
  assert.equal(await host.locator("#trafficLabel").textContent(), "回合結束");
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("紅燈停車員"); await host.locator("#createRoom").click();
  await host.locator("#lobbyView").waitFor({ state: "visible" });
  const code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  await guest.locator("#playerName").fill("手機闖關者"); await guest.locator("#joinRoom").click(); await guest.locator("#lobbyView").waitFor({ state: "visible" });
  await host.locator("#doorMode").selectOption("traffic"); await host.locator("#layoutMode").selectOption("fixed");
  await host.locator("#fixedLayout").fill("12"); await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "traffic" && document.querySelector("#fixedLayout").value === "12" && document.querySelector("#scoreToWin").value === "1");
  assert(await guest.locator("#doorMode").isDisabled()); await start();
  assert.deepEqual(await host.evaluate(() => window.__round.traffic), await guest.evaluate(() => window.__round.traffic));
  await phase(host, "green", 1.5);
  await host.locator("#board").focus(); await host.keyboard.down("ArrowRight");
  await host.waitForFunction(() => window.__resets.some(item => item.slot === 0 && item.penalized), null, { timeout: 10000 });
  assert.equal((await host.evaluate(() => window.__resets.find(item => item.slot === 0))).x, 392);
  assert((await host.evaluate(() => window.__discoveries)).includes(18), "紅燈前正常撞門");
  await host.waitForTimeout(500);
  assert.equal(await host.evaluate(() => window.__resets.filter(item => item.slot === 0 && item.penalized).length), 1, "持續按住不會重複處罰");
  await host.keyboard.up("ArrowRight");
  await phase(guest, "red", .8);
  await guest.locator('[data-key="KeyD"]').hover(); await guest.mouse.down();
  await guest.waitForFunction(() => window.__resets.some(item => item.slot === 1 && item.penalized)); await guest.mouse.up();
  assert.equal((await guest.evaluate(() => window.__resets.find(item => item.slot === 1))).x, 428);
  assert(await host.locator("#mathChallenge").isHidden());
  const gap = GAPS[18], pixel = await host.locator("#board").evaluate((canvas, gap) => [...canvas.getContext("2d").getImageData(Math.floor((gap.x + gap.w / 2) * canvas.width / 820), Math.floor((gap.y + gap.h / 2) * canvas.width / 820), 1, 1).data], gap);
  assert(pixel[1] > pixel[0] * 2, "傳回起點仍保留真門顏色");
  await noOverflow(host); await noOverflow(guest);
  await shot(host, "traffic-01-red-desktop.png"); await shot(guest, "traffic-02-red-mobile.png");
  await finishPath();
  assert.equal(await host.evaluate(() => window.__resets.filter(item => item.slot === 0 && item.penalized).length), 1, "遵守燈號可完整通關且不再受罰");
  await shot(host, "traffic-03-result.png");
  await host.locator("#returnLobby").click(); await host.locator("#proceduralMode").click(); await host.locator("#viewMode").check();
  await guest.waitForFunction(() => document.querySelector("#viewMode").checked && document.querySelector("#proceduralMode").getAttribute("aria-pressed") === "true");
  await start(); assert.equal(await host.locator("#board").getAttribute("data-view"), "fog");
  await shot(host, "traffic-04-fog.png"); await finishPath();
  assert.equal(await host.evaluate(() => window.__resets.filter(item => item.slot === 0 && item.penalized).length), 0, "紅綠燈搭配黑霧生成迷宮可通關");
  await guest.locator("#leaveRoom").click(); await host.locator("#lobbyView").waitFor({ state: "visible" });
  assert(await host.locator("#trafficSignal").isHidden()); assert.deepEqual(errors, []);
  console.log("OK: 紅綠燈桌機／手機操作、同步燈號、按住跨紅燈傳送、放開後再出發、探門記錄保留、官方及黑霧生成迷宮完整通關。");
} catch (error) {
  await shot(host, "traffic-failure-desktop.png"); await shot(guest, "traffic-failure-mobile.png"); throw error;
} finally { await browser.close(); }
