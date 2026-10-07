import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { allPaths, roomCX, roomCY, GAPS } from "./public/geometry.js";

const url = process.env.TEST_URL || "http://localhost:3000";
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const errors = [], output = new URL("./test-artifacts/", import.meta.url);
await mkdir(output, { recursive: true });
const hostContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
for (const context of [hostContext, guestContext]) await context.addInitScript(() => {
  let api;
  Object.defineProperty(window, "io", {
    configurable: true, get: () => api,
    set: original => {
      api = Object.assign((...args) => {
        const socket = original(...args), emit = socket.emit;
        socket.emit = function(event, data, ...rest) {
          if (event === "player:state") window.__position = data;
          if (event === "door:challenge") window.__door = data.doorId;
          if (event === "door:answer" && typeof rest.at(-1) === "function") {
            const callback = rest.at(-1);
            rest[rest.length - 1] = (...values) => { const reply = values.at(-1); if (reply?.correct) window.__reveals.push(reply); callback(...values); };
          }
          return emit.call(this, event, data, ...rest);
        };
        socket.on("round:start", data => { window.__round = data; window.__position = null; window.__result = null; window.__reveals = []; });
        socket.on("round:end", data => { window.__result = data; });
        return socket;
      }, original);
    },
  });
});
const host = await hostContext.newPage(), guest = await guestContext.newPage();
for (const page of [host, guest]) page.on("pageerror", error => errors.push(error.message));
const shot = (page, name) => page.screenshot({ path: fileURLToPath(new URL(name, output)), fullPage: true });
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
const solve = question => {
  const [, a, op, b] = question.match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  return op === "+" ? +a + +b : op === "−" ? +a - +b : op === "×" ? +a * +b : +a / +b;
};
async function gatePixel(page) {
  const doorId = await page.evaluate(() => window.__door), gap = GAPS[doorId];
  return page.locator("#board").evaluate((canvas, gap) => [...canvas.getContext("2d").getImageData(Math.floor((gap.x + gap.w / 2) * canvas.width / 820), Math.floor((gap.y + gap.h / 2) * canvas.width / 820), 1, 1).data], gap);
}
async function answerQuiz(page, wrongCount = 0, expectUnknown = true) {
  await page.waitForFunction(() => !document.querySelector("#mathChallenge").hidden && !document.querySelector("#mathAnswer").disabled);
  assert(await page.locator("#mathChallenge").evaluate(dialog => dialog.open && dialog.matches(":modal")), "題目必須是置頂的模態彈出視窗");
  const box = await page.locator("#mathChallenge").boundingBox(), viewport = page.viewportSize();
  assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height, "桌機／手機彈窗必須完整位於視窗內");
  assert(await page.locator("#mathAnswer").evaluate(input => document.activeElement === input), "自動聚焦答案欄");
  const question = await page.locator("#mathQuestion").textContent(), answer = solve(question);
  const doorId = await page.evaluate(() => window.__door), count = await page.evaluate(() => window.__reveals.length);
  for (let i = 0; i < wrongCount; i++) {
    await page.locator("#mathAnswer").fill(String(answer + 1)); await page.locator("#mathAnswer").press("Enter");
    await page.waitForFunction(attempt => document.querySelector("#mathFeedback").textContent.includes(`第 ${attempt} 次`), i + 1);
    assert.equal(await page.locator("#mathQuestion").textContent(), question);
    assert.equal(await page.evaluate(() => window.__reveals.length), count);
    assert(await page.locator("#mathChallenge").isVisible());
  }
  if (wrongCount) {
    const before = await page.evaluate(() => window.__position);
    const clock = Number(await page.locator("#clock").textContent());
    await page.keyboard.press("Escape");
    await page.mouse.click(4, 4);
    assert(await page.locator("#mathChallenge").evaluate(dialog => dialog.matches(":modal")), "Esc 與點背景不能跳過答題");
    await page.locator("#mathAnswer").focus();
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Tab");
      assert(await page.evaluate(() => document.activeElement === document.body || document.querySelector("#mathChallenge").contains(document.activeElement)), "Tab 不可聚焦背景控制項");
    }
    await page.locator("#mathAnswer").focus(); await page.keyboard.down("ArrowRight"); await page.waitForTimeout(160); await page.keyboard.up("ArrowRight");
    assert.deepEqual(await page.evaluate(() => window.__position), before, "答錯時必須凍結自己的位置");
    assert(Number(await page.locator("#clock").textContent()) > clock, "彈窗不暫停計時");
    await noOverflow(page);
    await shot(page, page === host ? "math-02-wrong-desktop.png" : "math-03-wrong-mobile.png");
    if (expectUnknown && (await page.evaluate(() => window.__round.settings.viewMode)) === "standard") {
      const pixel = await gatePixel(page);
      assert(pixel.every((value, index) => Math.abs(value - [26, 33, 28, 255][index]) <= 8), "答對前真假門保持未知顏色（允許角色陰影）");
    }
  }
  await page.locator("#mathAnswer").fill(String(answer)); await page.locator("#submitMath").click();
  await page.locator("#mathChallenge").waitFor({ state: "hidden" });
  assert.equal(await page.locator("#mathChallenge").evaluate(dialog => dialog.open), false, "答對關閉彈窗");
  const reveal = await page.evaluate(() => window.__reveals.at(-1));
  assert.equal(reveal.doorId, doorId);
  const round = await page.evaluate(() => window.__round);
  assert.equal(reveal.state, round.openDoors.includes(doorId) ? 1 : 2);
  if (round.settings.viewMode === "standard") {
    const gap = GAPS[doorId];
    await page.waitForFunction(({ gap, state }) => {
      const canvas = document.querySelector("#board");
      const pixel = canvas.getContext("2d").getImageData(Math.floor((gap.x + gap.w / 2) * canvas.width / 820), Math.floor((gap.y + gap.h / 2) * canvas.width / 820), 1, 1).data;
      return state === 1 ? pixel[1] > pixel[0] * 2 && pixel[1] > pixel[2] : pixel[0] > pixel[1] * 2 && pixel[0] > pixel[2] * 2;
    }, { gap, state: reveal.state }, { timeout: 5000 });
  }
  return reveal;
}
async function moveTo(x, y) {
  for (const [axis, target] of [["x", x], ["y", y]]) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const current = (await host.evaluate(() => window.__position))[axis];
      if (Math.abs(current - target) < 12) break;
      const increasing = current < target, key = axis === "x" ? increasing ? "ArrowRight" : "ArrowLeft" : increasing ? "ArrowDown" : "ArrowUp";
      await host.locator("#board").focus(); await host.keyboard.down(key);
      try {
        await host.waitForFunction(({ axis, target, increasing }) => window.__result || !document.querySelector("#mathChallenge").hidden || (increasing ? window.__position[axis] >= target - 8 : window.__position[axis] <= target + 8), { axis, target, increasing }, { timeout: 4000 });
      } finally { await host.keyboard.up(key); }
      if (await host.evaluate(() => Boolean(window.__result))) return;
      if (await host.locator("#mathChallenge").isVisible()) await answerQuiz(host);
      else break;
    }
  }
}
async function start() {
  const previous = await host.evaluate(() => window.__round?.roundId);
  await host.locator("#startRound").click();
  await host.waitForFunction(previous => window.__round && window.__round.roundId !== previous && window.__position, previous);
  await host.locator("#countdown").waitFor({ state: "hidden" });
}
try {
  await host.goto(url); await host.waitForFunction(() => !document.querySelector("#createRoom").disabled);
  await host.locator("#playerName").fill("數學冒險者"); await host.locator("#createRoom").click();
  await host.locator("#lobbyView").waitFor({ state: "visible" }); const code = await host.locator("#roomCode").textContent();
  await guest.goto(`${url}/?room=${code}`); await guest.waitForFunction(() => !document.querySelector("#joinRoom").disabled);
  await guest.locator("#playerName").fill("手機挑戰者"); await guest.locator("#joinRoom").click(); await guest.locator("#lobbyView").waitFor({ state: "visible" });
  await host.locator("#doorMode").selectOption("math"); await host.locator("#layoutMode").selectOption("fixed");
  await host.locator("#fixedLayout").fill("12"); await host.locator("#scoreToWin").fill("1"); await host.locator("#scoreToWin").press("Tab");
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "math" && document.querySelector("#fixedLayout").value === "12" && document.querySelector("#scoreToWin").value === "1");
  assert.equal(await host.locator("#viewMode").getAttribute("type"), "checkbox", "黑霧必須是獨立開關");
  assert(await host.locator("#shareDiscovery").isEnabled()); assert(await host.locator("#shareDiscovery").isChecked());
  await shot(host, "math-01-settings.png"); await start();
  await host.keyboard.down("ArrowLeft"); await host.locator("#mathChallenge").waitFor({ state: "visible" }); await host.keyboard.up("ArrowLeft");
  await guest.locator('[data-key="KeyA"]').hover();
  await guest.mouse.down(); await guest.locator("#mathChallenge").waitFor({ state: "visible" }); await guest.mouse.up();
  assert.equal((await answerQuiz(host, 3)).state, 2, "官方 #12 的左門是假的");
  assert(await guest.locator("#mathChallenge").isVisible(), "共享同門資訊不能取消對手題目");
  assert.match(await guest.locator("#mathDoorStatus").textContent(), /假門（關）.*仍須自己答對/);
  assert.equal((await answerQuiz(guest, 1, false)).state, 2);
  await host.keyboard.down("ArrowLeft"); await host.waitForTimeout(200); await host.keyboard.up("ArrowLeft");
  assert(await host.locator("#mathChallenge").isHidden(), "自己已答對的門不重複出題");
  const round = await host.evaluate(() => window.__round), path = allPaths(new Set(round.openDoors))[0];
  await moveTo(410, 730);
  await guest.locator('[data-key="KeyD"]').hover();
  await guest.mouse.down(); await guest.locator("#mathChallenge").waitFor({ state: "visible" }); await guest.mouse.up();
  await moveTo(roomCX(path[1]), roomCY(path[1]));
  assert(await guest.locator("#mathChallenge").isVisible(), "對手答對真門仍不能替自己解除限制");
  assert.match(await guest.locator("#mathDoorStatus").textContent(), /真門（開）.*仍須自己答對/);
  assert.equal((await answerQuiz(guest, 1, false)).state, 1);
  for (const room of path.slice(2)) await moveTo(roomCX(room), roomCY(room));
  await host.locator("#resultInfo").waitFor({ state: "visible" });
  assert.equal((await host.evaluate(() => window.__result)).winner, 0);
  assert(await host.locator("#mathChallenge").isHidden());
  await shot(host, "math-04-result.png");
  await host.locator("#returnLobby").click(); await host.locator("#proceduralMode").click(); await host.locator("#viewMode").check();
  await guest.waitForFunction(() => document.querySelector("#doorMode").value === "math" && document.querySelector("#viewMode").checked && document.querySelector("#proceduralMode").getAttribute("aria-pressed") === "true");
  await start();
  const fogRound = await host.evaluate(() => window.__round); assert.equal(fogRound.settings.doorMode, "math"); assert.equal(fogRound.settings.viewMode, "fog");
  await shot(host, "math-05-fog-start.png");
  const fogPath = allPaths(new Set(fogRound.openDoors))[0];
  for (const room of fogPath.slice(1)) await moveTo(roomCX(room), roomCY(room));
  await host.locator("#resultInfo").waitFor({ state: "visible" });
  assert.equal((await host.evaluate(() => window.__result)).winner, 0);
  assert.equal((await host.evaluate(() => window.__reveals)).filter(reveal => reveal.state === 1).length, fogPath.length - 1, "完整通關必須答對沿途每一扇真門");
  await host.locator("#nextRound").click();
  await host.waitForFunction(previous => window.__round?.roundId !== previous && window.__position, fogRound.roundId);
  await host.locator("#countdown").waitFor({ state: "hidden" });
  await host.locator("#board").focus(); await host.keyboard.down("ArrowLeft");
  await host.locator("#mathChallenge").waitFor({ state: "visible" }); await host.keyboard.up("ArrowLeft");
  await guest.locator("#leaveRoom").click();
  await host.locator("#lobbyView").waitFor({ state: "visible" });
  assert.equal(await host.locator("#mathChallenge").evaluate(dialog => dialog.open), false, "對手離房取消回合時關閉彈窗");
  assert(await host.locator("#mathChallenge").isHidden());
  await noOverflow(guest); assert.deepEqual(errors, []);
  console.log("OK: 桌機／手機數學彈窗、焦點限制、Esc／背景不能略過、錯答及各自解鎖、共享情報、計時繼續、離房關閉與官方／黑霧生成迷宮通關。");
} catch (error) {
  await shot(host, "math-failure-desktop.png"); await shot(guest, "math-failure-mobile.png");
  for (const page of [host, guest]) console.error("Math GUI diagnostic:", await page.evaluate(() => ({ door: window.__door, position: window.__position, reveals: window.__reveals, feedback: document.querySelector("#mathFeedback").textContent })), "gatePixel:", await gatePixel(page));
  throw error;
} finally { await browser.close(); }
