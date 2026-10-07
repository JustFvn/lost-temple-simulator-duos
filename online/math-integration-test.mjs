import assert from "node:assert/strict";
import { io } from "socket.io-client";
import { GAPS } from "./public/geometry.js";

const url = process.env.TEST_URL || "http://localhost:3000";
const host = io(url, { forceNew: true }), guest = io(url, { forceNew: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const once = (socket, event) => new Promise((resolve, reject) => {
  const handler = data => { clearTimeout(timer); resolve(data); };
  const timer = setTimeout(() => { socket.off(event, handler); reject(new Error(`等待 ${event} 逾時`)); }, 7000);
  socket.once(event, handler);
});
const ack = (socket, event, data = {}) => new Promise((resolve, reject) => socket.timeout(7000).emit(event, data, (error, value) => error ? reject(error) : resolve(value)));
const solve = question => {
  const [, a, op, b] = question.match(/^(\d+) ([+−×÷]) (\d+) = \?$/);
  return op === "+" ? +a + +b : op === "−" ? +a - +b : op === "×" ? +a * +b : +a / +b;
};
try {
  await Promise.all([once(host, "connect"), once(guest, "connect")]);
  const created = await ack(host, "room:create", { name: "數學房主" });
  await ack(guest, "room:join", { code: created.room.code, name: "數學對手" });
  const settings = { ...created.room.settings, doorMode: "math", viewMode: "scroll", layoutMode: "fixed", fixedLayout: 12, shareDiscovery: true };
  assert.equal((await ack(host, "settings:update", { ...settings, doorMode: "invalid" })).ok, false);
  assert.equal((await ack(guest, "settings:update", settings)).ok, false);
  assert.equal((await ack(host, "settings:update", settings)).ok, true);
  let started = once(host, "round:start"); await ack(host, "round:start");
  const round = await started;
  assert.equal(round.settings.doorMode, "math"); assert.equal(round.settings.viewMode, "scroll");
  assert.equal(round.settings.shareDiscovery, true, "數學模式仍共享真假資訊");
  assert.equal((await ack(host, "door:challenge", { roundId: round.roundId, doorId: 17 })).ok, false, "倒數中不可取得題目");
  await wait(Math.max(0, round.startsAt - Date.now() + 30));
  assert.equal((await ack(host, "door:challenge", { roundId: round.roundId, doorId: 0 })).ok, false, "不能遠距取得題目");
  assert.equal((await ack(host, "door:challenge", { roundId: round.roundId, doorId: 39 })).ok, false);
  const trueDoor = round.openDoors[0], falseDoor = GAPS.findIndex((_, id) => !round.openDoors.includes(id));
  let oldId;
  for (const doorId of [trueDoor, falseDoor]) {
    const gap = GAPS[doorId], x = gap.x - 10, y = gap.y + gap.h / 2;
    host.emit("player:state", { roundId: round.roundId, x, y, steps: 0 });
    const initial = await ack(host, "door:challenge", { roundId: round.roundId, doorId });
    assert.equal(initial.ok, true); assert(initial.challenge);
    assert(!("answer" in initial.challenge) && !("state" in initial), "答對前不可傳真假門或答案");
    const answer = solve(initial.challenge.question), id = initial.challenge.id; oldId = id;
    assert.equal((await ack(guest, "door:answer", { roundId: round.roundId, challengeId: id, answer })).ok, false, "不能代答對手題目");
    assert.equal((await ack(host, "door:challenge", { roundId: round.roundId, doorId: (doorId + 1) % 39 })).ok, false, "不能跳過未答對的題目");
    for (let attempt = 1; attempt <= 20; attempt++) {
      const wrong = await ack(host, "door:answer", { roundId: round.roundId, challengeId: id, answer: attempt === 1 ? "" : answer + 1 });
      assert.equal(wrong.correct, false); assert.equal(wrong.attempts, attempt); assert(!("state" in wrong));
    }
    host.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 50 });
    assert.equal((await ack(host, "goal:reached", { roundId: round.roundId })).ok, false, "答題中不能計分或移動");
    const same = await ack(host, "door:challenge", { roundId: round.roundId, doorId });
    assert.equal(same.challenge.id, id); assert.equal(same.challenge.question, initial.challenge.question);
    guest.emit("player:state", { roundId: round.roundId, x, y, steps: 0 });
    const guestQuestion = await ack(guest, "door:challenge", { roundId: round.roundId, doorId });
    assert(guestQuestion.challenge, "兩人同門各有題目");
    const shared = once(guest, "door:discover");
    const correct = await ack(host, "door:answer", { roundId: round.roundId, challengeId: id, answer: String(answer) });
    assert.equal(correct.correct, true); assert.equal(correct.state, doorId === trueDoor ? 1 : 2);
    const discovery = await shared; assert.equal(discovery.doorId, doorId); assert.equal(discovery.state, correct.state);
    assert.equal((await ack(host, "goal:reached", { roundId: round.roundId })).ok, false, "答題中移動應已被拒絕");
    const known = await ack(host, "door:challenge", { roundId: round.roundId, doorId });
    assert.equal(known.solved, true); assert.equal(known.state, correct.state);
    const stillPending = await ack(guest, "door:challenge", { roundId: round.roundId, doorId });
    assert.equal(stillPending.challenge.id, guestQuestion.challenge.id, "一人答對不能取消另一人的題目");
    guest.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 80 });
    assert.equal((await ack(guest, "goal:reached", { roundId: round.roundId })).ok, false, "已共享真假資訊也不能跳過自己的題目");
    const guestAnswer = solve(guestQuestion.challenge.question);
    const guestCorrect = await ack(guest, "door:answer", { roundId: round.roundId, challengeId: guestQuestion.challenge.id, answer: guestAnswer });
    assert.equal(guestCorrect.state, correct.state); assert.equal(guestCorrect.correct, true);
    assert.equal((await ack(host, "door:answer", { roundId: round.roundId, challengeId: id, answer })).ok, false, "題目只能成功一次");
  }
  const ended = once(guest, "round:end");
  host.emit("player:state", { roundId: round.roundId, x: 410, y: 90, steps: 8 });
  await ack(host, "goal:reached", { roundId: round.roundId }); await ended;
  started = once(host, "round:start"); await ack(host, "round:start"); const next = await started;
  assert.equal((await ack(host, "door:answer", { roundId: round.roundId, challengeId: oldId, answer: 1 })).ok, false);
  await wait(Math.max(0, next.startsAt - Date.now() + 30));
  const gap = GAPS[trueDoor];
  host.emit("player:state", { roundId: next.roundId, x: gap.x - 10, y: gap.y + gap.h / 2, steps: 0 });
  const fresh = await ack(host, "door:challenge", { roundId: next.roundId, doorId: trueDoor });
  assert(fresh.challenge, "新回合清除已答對的門");
  console.log("OK: 數學題伺服器驗證、20 次錯答重試、答對共享真假但對手仍受自己的題目限制、不能代答、回合隔離與捲軸獨立搭配。");
} finally { host.disconnect(); guest.disconnect(); }
