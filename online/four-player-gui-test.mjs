import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY } from "./public/geometry.js";
import { PLAYER_STYLES, spawnPosition } from "./public/players.js";
const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const pages = [], errors = [], output = new URL("./test-artifacts/", import.meta.url);
await mkdir(output, { recursive: true });
for (let slot = 0; slot < 4; slot++) {
  const context = await browser.newContext(slot === 3 ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 1000 } });
  await context.addInitScript(slot => {
    let api;
    Object.defineProperty(window, "io", { configurable: true, get: () => api, set: original => {
      api = Object.assign((...args) => {
        const socket = original(...args), emit = socket.emit;
        socket.emit = function(event, data, ...rest) { if (event === "player:state") window.__position = data; return emit.call(this, event, data, ...rest); };
        socket.on("round:start", data => { window.__round = data; window.__position = null; window.__result = null; window.__resets = []; });
        socket.on("round:end", data => { window.__result = data; });
        socket.on("player:reset", data => { window.__resets.push(data); if (data.slot === slot) window.__position = data; });
        return socket;
      }, original);
    } });
  }, slot);
  const page = await context.newPage(); page.on("pageerror", error => errors.push(error.message)); pages.push(page);
}
const [host, second, third, fourth] = pages;
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "不得水平溢出");
async function start(participants = pages) {
  const previous = await host.evaluate(() => window.__round?.roundId);
  await host.locator("#startRound").click();
  await Promise.all(participants.map(page => page.waitForFunction(previous => window.__round && window.__round.roundId !== previous && window.__position, previous)));
  await host.locator("#countdown").waitFor({ state: "hidden" });
}
async function answer(page, wrong = false) {
  await page.waitForFunction(() => document.querySelector("#mathChallenge").open && !document.querySelector("#mathAnswer").disabled);
  const question = await page.locator("#mathQuestion").textContent(), [, a, op, b] = question.match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  const value = op === "+" ? +a + +b : op === "−" ? +a - +b : op === "×" ? +a * +b : +a / +b;
  if (wrong) {
    await page.locator("#mathAnswer").fill(String(value + 1)); await page.locator("#submitMath").click();
    await page.waitForFunction(() => document.querySelector("#mathFeedback").textContent.includes("第 1 次"));
    assert.equal(await page.locator("#mathQuestion").textContent(), question);
    const before = await page.evaluate(() => window.__position); await page.keyboard.press("ArrowRight");
    assert.deepEqual(await page.evaluate(() => window.__position), before);
  }
  await page.locator("#mathAnswer").fill(String(value)); await page.locator("#submitMath").click(); await page.locator("#mathChallenge").waitFor({ state: "hidden" });
}
async function moveTo(page, x, y) {
  for (const [axis, target] of [["x", x], ["y", y]]) for (let attempt = 0; attempt < 12; attempt++) {
    const current = (await page.evaluate(() => window.__position))[axis];
    if (Math.abs(current - target) < 12) break;
    const increasing = current < target, key = axis === "x" ? increasing ? "ArrowRight" : "ArrowLeft" : increasing ? "ArrowDown" : "ArrowUp";
    await page.locator("#board").focus(); await page.keyboard.down(key);
    try {
      await page.waitForFunction(({ axis, target, increasing }) => window.__result || document.querySelector("#mathChallenge").open || (increasing ? window.__position[axis] >= target - 8 : window.__position[axis] <= target + 8), { axis, target, increasing }, { timeout: 4500 });
    } finally { await page.keyboard.up(key); }
    if (await page.evaluate(() => Boolean(window.__result))) return;
    if (await page.locator("#mathChallenge").isVisible()) await answer(page);
    else break;
    if (attempt === 11) throw new Error("移動未完成");
  }
}
async function finish(page, participants = pages) {
  const round = await page.evaluate(() => window.__round), path = allPaths(new Set(round.openDoors))[0];
  for (const room of path) await moveTo(page, roomCX(room), roomCY(room));
  await Promise.all(participants.map(page => page.locator("#resultInfo").waitFor({ state: "visible" })));
  for (const participant of participants) {
    assert.equal((await participant.evaluate(() => window.__result)).matchWinner, 3);
    assert.equal(await participant.locator("#p4Score").textContent(), "1");
  }
  assert.equal(await page.locator("#resultTitle").textContent(), "你贏得整場！");
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("藍色房主"); await host.locator("#createRoom").click(); await host.locator("#lobbyView").waitFor({ state: "visible" });
  assert(await host.locator("#startRound").isDisabled()); const code = await host.locator("#roomCode").textContent();
  for (const [index, page] of pages.slice(1).entries()) {
    await page.goto(`${url}/?room=${code}`); await page.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
    await page.locator("#playerName").fill(`${PLAYER_STYLES[index + 1].name}冒險者`); await page.locator("#joinRoom").click(); await page.locator("#lobbyView").waitFor({ state: "visible" });
    await host.waitForFunction(count => document.querySelector("#seatCount").textContent === `${count} / 4`, index + 2);
    assert(await host.locator("#startRound").isEnabled(), "二／三／四人均可開局");
  }
  for (const page of pages) {
    await page.waitForFunction(() => document.querySelector("#seatCount").textContent === "4 / 4");
    assert.equal(await page.locator(".seat:not(.empty)").count(), 4); await noOverflow(page);
  }
  await shot(host, "four-01-lobby-desktop.png"); await shot(fourth, "four-02-lobby-mobile.png");
  await host.locator("#layoutMode").selectOption("fixed"); await host.locator("#fixedLayout").fill("12");
  await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab"); await start();
  for (const page of pages) { assert.equal(await page.locator(".score-player:not([hidden])").count(), 4); await noOverflow(page); }
  const colors = await host.locator("#board").evaluate((canvas, styles) => {
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    return styles.map(style => { const rgb = style.color.slice(1).match(/../g).map(hex => parseInt(hex, 16)); let count = 0;
      for (let i = 0; i < pixels.length; i += 4) if (rgb.every((value, index) => Math.abs(pixels[i + index] - value) <= 8)) count++;
      return count;
    });
  }, PLAYER_STYLES);
  assert(colors.every(count => count > 10), `四個角色皆繪製成自己的顏色（允許抗鋸齒與陰影）：${colors}`);
  assert.match(await fourth.locator("#yourSeat").textContent(), /4P · 紫色/);
  await shot(host, "four-03-game-desktop.png"); await shot(fourth, "four-04-game-mobile.png");
  await fourth.locator('[data-key="KeyA"]').hover(); await fourth.mouse.down(); await fourth.waitForTimeout(140); await fourth.mouse.up();
  assert((await fourth.evaluate(() => window.__position)).x < 428, "4P 的手機方向按鈕可移動");
  await finish(fourth); await shot(fourth, "four-05-winner-mobile.png");
  await host.locator("#returnLobby").click(); await host.locator("#doorMode").selectOption("math"); await host.locator("#viewMode").check(); await start();
  for (const page of pages) {
    await page.locator("#board").focus(); await page.keyboard.down("ArrowLeft");
    await page.locator("#mathChallenge").waitFor({ state: "visible" }); await page.keyboard.up("ArrowLeft");
  }
  await answer(host);
  for (const page of [second, third, fourth]) {
    assert(await page.locator("#mathChallenge").isVisible(), "一人答對不能解除其他三人的題目");
    assert.match(await page.locator("#mathDoorStatus").textContent(), /假門（關）.*仍須自己答對/);
  }
  await shot(fourth, "four-06-math-mobile.png");
  for (const page of [second, third, fourth]) await answer(page, page === fourth);
  await finish(fourth);
  await host.locator("#returnLobby").click(); await host.locator("#doorMode").selectOption("traffic"); await host.locator("#viewMode").uncheck(); await start();
  await third.waitForFunction(() => document.querySelector("#trafficSignal").dataset.phase === "red" && parseFloat(document.querySelector("#trafficCountdown").textContent) > 1.3, null, { timeout: 15000 });
  await third.locator("#board").focus(); await third.keyboard.down("ArrowUp");
  await third.waitForFunction(() => window.__resets.some(item => item.slot === 2 && item.penalized)); await third.keyboard.up("ArrowUp");
  await fourth.locator('[data-key="KeyD"]').hover(); await fourth.mouse.down();
  await fourth.waitForFunction(() => window.__resets.some(item => item.slot === 3 && item.penalized)); await fourth.mouse.up();
  for (const [slot, page] of [[2, third], [3, fourth]]) {
    const reset = await page.evaluate(slot => window.__resets.find(item => item.slot === slot), slot);
    assert.deepEqual({ x: reset.x, y: reset.y }, spawnPosition(slot));
  }
  assert.equal(await host.evaluate(() => window.__resets.filter(item => item.slot === 0 && item.penalized).length), 0);
  await shot(fourth, "four-07-traffic-mobile.png");
  await second.locator("#leaveRoom").click(); await host.locator("#lobbyView").waitFor({ state: "visible" });
  assert.equal(await host.locator("#seatCount").textContent(), "3 / 4");
  assert(await host.locator("#seat1").evaluate(el => el.classList.contains("empty")));
  await host.locator("#doorMode").selectOption("normal"); await start([host, third, fourth]);
  assert.deepEqual((await fourth.evaluate(() => window.__round.players)).map(player => player.slot), [0, 2, 3]);
  assert.equal(await fourth.locator(".score-player:not([hidden])").count(), 3); assert(await fourth.locator("#scorePlayer1").isHidden());
  await finish(fourth, [host, third, fourth]);
  await second.locator("#joinCode").fill(code); await second.locator("#joinRoom").click(); await second.locator("#lobbyView").waitFor({ state: "visible" });
  await host.waitForFunction(() => document.querySelector("#seatCount").textContent === "4 / 4");
  assert.equal(await host.locator("#p4Score").textContent(), "0");
  await host.locator("#leaveRoom").click(); await Promise.all(pages.map(page => page.locator("#homeView").waitFor({ state: "visible" })));
  assert.deepEqual(errors, []);
  console.log("OK: 四個瀏覽器／手機席位與角色顏色、4P觸控及通關勝利、四人數學題各自限制、3P／4P紅燈傳送、三人空席位遊玩、補位與房主關房。");
} catch (error) {
  await shot(host, "four-failure-desktop.png"); await shot(fourth, "four-failure-mobile.png"); throw error;
} finally { await browser.close(); }
