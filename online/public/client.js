import { DOORS } from "./layouts.js";
import { BOARD, ROOM, WALL, PR, SPEED, START_I, GOAL_I, pos, GAPS, allPaths, buildWalls, roomStates } from "./geometry.js";
import { paintBoard } from "./renderer.js";

const $ = selector => document.querySelector(selector);
const socket = window.io();
const canvas = $("#board"), ctx = canvas.getContext("2d");
const held = new Set();
const CONTROL = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
let room = null, slot = -1, run = null, currentView = "home", serverOffset = 0;
let noticeTimer, settingsTimer, entryBusy = false, starting = false, lastSent = 0;
const isHost = () => room?.hostId === socket.id;
const fmt = ms => (Math.max(0, ms) / 1000).toFixed(2);

function notify(message) {
  $("#notice").textContent = message; $("#notice").hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, 4500);
}
function showView(view) {
  currentView = view; held.clear();
  for (const name of ["home", "lobby", "game"]) $(`#${name}View`).hidden = name !== view;
  if (view === "game") fitCanvas();
}
function request(event, data = {}) {
  return new Promise((resolve, reject) => {
    if (!socket.connected) return reject(new Error("尚未連上伺服器，請稍候。"));
    socket.timeout(7000).emit(event, data, (error, result) => {
      if (error) return reject(new Error("連線逾時，請確認網路後再試。"));
      if (!result?.ok) return reject(new Error(result?.error || "操作失敗。"));
      resolve(result);
    });
  });
}
function syncConnection() {
  $("#connectionBadge").classList.toggle("connected", socket.connected);
  $("#connectionBadge").classList.toggle("offline", !socket.connected);
  $("#connectionBadge").innerHTML = `<i></i>${socket.connected ? "已連線" : "重新連線中"}`;
  $("#createRoom").disabled = $("#joinRoom").disabled = !socket.connected || entryBusy;
}
socket.on("connect", () => {
  syncConnection();
  const sentAt = Date.now();
  socket.timeout(5000).emit("clock:sync", {}, (error, data) => {
    if (!error) serverOffset = data.serverNow - (sentAt + Date.now()) / 2;
  });
});
function clearRoom() {
  room = null; run = null; slot = -1; held.clear(); clearTimeout(settingsTimer);
  $("#roomBadge").hidden = $("#leaveRoom").hidden = true;
  history.replaceState(null, "", location.pathname); showView("home");
}
socket.on("disconnect", () => {
  if (room) { clearRoom(); notify("連線中斷，已離開房間。重新連線後請重新加入。"); }
  syncConnection();
});
socket.on("room:closed", message => { clearRoom(); notify(message); });

const inviteCode = new URL(location.href).searchParams.get("room");
if (inviteCode) {
  $("#joinCode").value = inviteCode.toUpperCase().slice(0, 6);
  $("#entryTitle").textContent = "朋友在等你。";
  $("#entryHint").textContent = "先取個暱稱，再按「加入」進入邀請的房間。";
}
$("#heroTiles").replaceChildren(...Array.from({ length: 25 }, (_, i) => {
  const tile = document.createElement("i");
  if ([2, 6, 7, 8, 10, 11, 13, 14, 15, 16, 18, 19, 21, 22, 23].includes(i)) tile.className = "lit";
  return tile;
}));
async function enter(event) {
  const name = $("#playerName").value.trim();
  if (!name) { $("#playerName").focus(); notify("先輸入你的暱稱。"); return; }
  const code = $("#joinCode").value.trim().toUpperCase();
  if (event === "room:join" && !/^[A-Z2-9]{6}$/.test(code)) { $("#joinCode").focus(); notify("請輸入六碼房間代碼。"); return; }
  entryBusy = true; syncConnection();
  try {
    const data = await request(event, { name, code });
    slot = data.slot; updateRoom(data.room); showView("lobby");
    history.replaceState(null, "", `${location.pathname}?room=${data.room.code}`);
  } catch (error) { notify(error.message); }
  finally { entryBusy = false; syncConnection(); }
}
$("#createRoom").addEventListener("click", () => enter("room:create"));
$("#joinRoom").addEventListener("click", () => enter("room:join"));
$("#joinCode").addEventListener("input", event => { event.target.value = event.target.value.toUpperCase().replace(/[^A-Z2-9]/g, ""); });
$("#joinCode").addEventListener("keydown", event => { if (event.key === "Enter") enter("room:join"); });
$("#leaveRoom").addEventListener("click", async () => {
  try { await request("room:leave"); clearRoom(); } catch (error) { notify(error.message); }
});
$("#copyInvite").addEventListener("click", async () => {
  if (!room) return;
  const link = new URL(location.href); link.search = ""; link.searchParams.set("room", room.code);
  try { await navigator.clipboard.writeText(link.href); notify("邀請連結已複製，傳給朋友即可。"); }
  catch { notify(`無法自動複製，請分享網址列的連結（房號 ${room.code}）。`); }
});

function applySettings(settings) {
  for (const key of ["layoutMode", "drawMode", "fixedLayout", "scoreToWin"]) $(`#${key}`).value = settings[key];
  for (const key of ["shareDiscovery", "revealAfterRound"]) $(`#${key}`).checked = settings[key];
  for (const button of document.querySelectorAll("[data-mode]")) {
    const selected = button.dataset.mode === settings.mapMode;
    button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected));
  }
  syncSettingsDisplay();
}
function syncSettingsDisplay() {
  const generated = $("#proceduralMode").classList.contains("selected");
  $("#officialSettings").hidden = generated;
  $("#modeDescription").textContent = generated ? "不抽選官方關卡。程式每回合生成新迷宮，保證恰有兩條可抵達 E3 的分岔路線。" : "使用真實佈局資料，可依官方機率抽選。";
  const fixed = $("#layoutMode").value === "fixed";
  $("#fixedLayoutField").hidden = !fixed; $("#drawModeField").hidden = fixed;
  for (const button of document.querySelectorAll("[data-score]")) button.classList.toggle("selected", button.dataset.score === $("#scoreToWin").value);
}
function readSettings() {
  for (const id of ["scoreToWin", "fixedLayout"]) {
    const input = $(`#${id}`);
    if (!input.checkValidity() || !input.value) { input.reportValidity(); throw new Error(id === "scoreToWin" ? "勝利分數請輸入 1–99 的整數。" : "佈局編號請輸入 0–124。"); }
  }
  return { mapMode: $("#proceduralMode").classList.contains("selected") ? "procedural" : "official", drawMode: $("#drawMode").value, layoutMode: $("#layoutMode").value, fixedLayout: Number($("#fixedLayout").value), scoreToWin: Number($("#scoreToWin").value), shareDiscovery: $("#shareDiscovery").checked, revealAfterRound: $("#revealAfterRound").checked };
}
async function saveSettings() {
  clearTimeout(settingsTimer);
  if (!isHost() || room.status === "playing") return;
  const settings = readSettings();
  if (JSON.stringify(settings) !== JSON.stringify(room.settings)) await request("settings:update", settings);
}
function queueSettings() {
  syncSettingsDisplay(); clearTimeout(settingsTimer);
  settingsTimer = setTimeout(() => saveSettings().catch(error => notify(error.message)), 300);
}
$("#hostSettings").addEventListener("change", queueSettings);
for (const button of document.querySelectorAll("[data-mode]")) button.addEventListener("click", () => {
  for (const option of document.querySelectorAll("[data-mode]")) {
    const selected = option === button; option.classList.toggle("selected", selected); option.setAttribute("aria-pressed", String(selected));
  }
  queueSettings();
});
for (const button of document.querySelectorAll("[data-score]")) button.addEventListener("click", () => { $("#scoreToWin").value = button.dataset.score; queueSettings(); });
function updateRoom(data) {
  const previousStatus = room?.status;
  room = data; slot = room.players.find(player => player.id === socket.id)?.slot ?? slot;
  $("#roomBadge").hidden = $("#leaveRoom").hidden = false;
  $("#roomBadge").textContent = room.code; $("#roomCode").textContent = room.code;
  $("#seatCount").textContent = `${room.players.length} / 2`;
  for (let i = 0; i < 2; i++) {
    const player = room.players.find(p => p.slot === i);
    $(`#seat${i}Name`).textContent = player?.name || "等待冒險者";
    $(`#seat${i}`).classList.toggle("empty", !player);
    $(`#p${i + 1}Name`).textContent = `${player?.name || "等待中"}${slot === i ? "（你）" : ""}`;
    $(`#p${i + 1}Score`).textContent = room.scores[i];
  }
  $("#seat1State").textContent = room.players.length === 2 ? "已加入" : "等待中";
  $("#lobbySubtitle").textContent = isHost() ? "你是房主。選好規則，邀請朋友一起出發。" : "你是挑戰者。房主會設定規則並開始對戰。";
  $("#hostOnlyNote").textContent = isHost() ? "房主設定" : "由房主設定";
  $("#hostSettings").disabled = !isHost() || room.status === "playing";
  $("#settingsNote").textContent = room.status === "playing" ? "回合進行中，設定已鎖定；回合結束後可修改。" : "設定自動同步給對手；修改規則會重置比分。";
  applySettings(room.settings);
  $("#matchTarget").textContent = `先得 ${room.settings.scoreToWin} 分獲勝`;
  $("#startRound").disabled = starting || (room.status !== "playing" && (!isHost() || room.players.length !== 2));
  $("#startRound").textContent = room.status === "playing" ? "返回對戰 →" : room.players.length !== 2 ? "等待對手加入" : isHost() ? (room.roundNumber ? "繼續對戰 →" : "開始對戰 →") : "等待房主開始";
  if (room.status === "lobby" && (run || previousStatus === "ended" || previousStatus === "playing")) {
    if (previousStatus === "playing") notify("對手已離開，回合已取消、比分已重置。");
    run = null; showView("lobby");
  }
}
socket.on("room:state", updateRoom);
async function startRound() {
  if (room?.status === "playing") { showView("game"); return; }
  if (starting) return;
  starting = true; $("#startRound").disabled = $("#nextRound").disabled = true;
  try { await saveSettings(); await request("round:start"); }
  catch (error) { notify(error.message); }
  finally { starting = false; $("#nextRound").disabled = false; if (room) updateRoom(room); }
}
$("#startRound").addEventListener("click", startRound);
$("#nextRound").addEventListener("click", startRound);
$("#gameLobby").addEventListener("click", () => showView("lobby"));
$("#returnLobby").addEventListener("click", () => showView("lobby"));
$("#toggleRoutes").addEventListener("click", () => {
  if (!run?.done || !run.settings.revealAfterRound) return;
  run.showRoutes = !run.showRoutes;
  $("#toggleRoutes").textContent = run.showRoutes ? "隱藏路線" : "查看兩條路線";
});

socket.on("round:start", data => {
  if (!room) return;
  held.clear(); lastSent = 0;
  // Convert the shared server start time to a monotonic local deadline.
  const wait = Math.max(0, data.startsAt - (Date.now() + serverOffset));
  run = { ...data, open: new Set(data.openDoors), walls: buildWalls(new Set(data.openDoors)), doors: new Int8Array(DOORS.length), visited: new Uint8Array(25), flash: new Map(), players: [0, 1].map(i => ({ x: 392 + 36 * i, y: 730, room: START_I, steps: 0 })), started: performance.now() + wait, elapsed: 0, done: false, goalPending: false, showRoutes: false };
  run.visited[START_I] = 1;
  run.paths = allPaths(run.open);
  $("#gameModeLabel").textContent = data.settings.mapMode === "procedural" ? "GENERATED MAZE" : "OFFICIAL MAZE";
  $("#roundTitle").textContent = `第 ${data.roundNumber} 回合`;
  $("#mapLabel").textContent = data.layoutId === null ? "程式生成 · 兩條分岔" : `官方佈局 #${data.layoutId}`;
  $("#raceInfo").hidden = false; $("#resultInfo").hidden = true;
  $("#countdown").hidden = false; $("#countdownValue").textContent = "3";
  $("#yourSeat").textContent = `你是 ${slot + 1}P · ${slot === 0 ? "藍色" : "粉色"}`;
  $("#yourSeat").classList.toggle("pink", slot === 1);
  for (let i = 0; i < 2; i++) $(`#p${i + 1}Score`).textContent = data.scores[i];
  showView("game");
});
socket.on("player:state", data => {
  if (!run || run.done || data.roundId !== run.roundId || data.slot === slot) return;
  Object.assign(run.players[data.slot], { x: data.x, y: data.y, steps: data.steps });
  if (run.settings.shareDiscovery) markRoom(run.players[data.slot], false);
});
socket.on("door:discover", data => {
  if (!run || run.done || data.roundId !== run.roundId) return;
  run.doors[data.doorId] = data.state; run.flash.set(data.doorId, 1);
});
socket.on("round:end", data => {
  if (!run || data.roundId !== run.roundId) return;
  run.done = true; run.elapsed = data.elapsedMs; held.clear();
  for (const player of data.players) Object.assign(run.players[player.slot], player);
  run.showRoutes = run.settings.revealAfterRound;
  $("#countdown").hidden = true; $("#raceInfo").hidden = true; $("#resultInfo").hidden = false;
  const won = data.winner === slot, matchDone = data.matchWinner !== -1;
  const name = room.players.find(p => p.slot === data.winner)?.name || `${data.winner + 1}P`;
  $("#resultKicker").textContent = matchDone ? "MATCH COMPLETE" : "ROUND COMPLETE";
  $("#resultTitle").textContent = matchDone ? won ? "你贏得整場！" : "對手贏得整場" : won ? "這一分，你的。" : "對手先到一步。";
  $("#resultDescription").textContent = `${name} 先抵達王冠，${matchDone ? `率先拿下 ${run.settings.scoreToWin} 分。` : `目前比分 ${data.scores.join(" : ")}。`}`;
  $("#resultTime").textContent = `${fmt(data.elapsedMs)} 秒`; $("#resultSteps").textContent = `${data.steps} 步`;
  $("#routeStat").hidden = $("#toggleRoutes").hidden = !run.settings.revealAfterRound;
  $("#routeLengths").textContent = `${data.routeLengths?.join(" / ") || "—"} 步`;
  $("#toggleRoutes").textContent = "隱藏路線";
  $("#nextRound").hidden = !isHost(); $("#guestWait").hidden = isHost();
  $("#nextRound").textContent = matchDone ? "再來一場 →" : "下一回合 →";
  for (let i = 0; i < 2; i++) $(`#p${i + 1}Score`).textContent = data.scores[i];
  showView("game");
});

addEventListener("keydown", event => {
  if (currentView !== "game" || !CONTROL[event.code] || event.target.closest("input, select, textarea") || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault(); held.add(event.code);
});
addEventListener("keyup", event => held.delete(event.code));
addEventListener("blur", () => held.clear());
document.addEventListener("visibilitychange", () => { if (document.hidden) held.clear(); });
for (const button of document.querySelectorAll("[data-key]")) {
  button.addEventListener("pointerdown", event => { event.preventDefault(); if (currentView !== "game") return; button.setPointerCapture(event.pointerId); held.add(button.dataset.key); });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) button.addEventListener(name, () => held.delete(button.dataset.key));
}
function collide(player) {
  for (const wall of run.walls) {
    const cx = Math.max(wall.x, Math.min(player.x, wall.x + wall.w));
    const cy = Math.max(wall.y, Math.min(player.y, wall.y + wall.h));
    const dx = player.x - cx, dy = player.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= PR * PR) continue;
    if (d2 > 1e-6) {
      const distance = Math.sqrt(d2); player.x = cx + dx / distance * PR; player.y = cy + dy / distance * PR;
    } else {
      const l = player.x - wall.x, r = wall.x + wall.w - player.x, t = player.y - wall.y, b = wall.y + wall.h - player.y;
      const m = Math.min(l, r, t, b);
      if (m === l) player.x = wall.x - PR; else if (m === r) player.x = wall.x + wall.w + PR;
      else if (m === t) player.y = wall.y - PR; else player.y = wall.y + wall.h + PR;
    }
  }
}
function sendPosition() {
  const { x, y, steps } = run.players[slot];
  socket.emit("player:state", { roundId: run.roundId, x, y, steps });
}
function markRoom(player, local) {
  const c = Math.floor((player.x - WALL) / (ROOM + WALL)), r = Math.floor((player.y - WALL) / (ROOM + WALL));
  if (r < 0 || r > 4 || c < 0 || c > 4) return;
  if (player.x > pos(c) + ROOM || player.y > pos(r) + ROOM) return;
  const index = r * 5 + c; run.visited[index] = 1;
  if (!local) return;
  if (index !== player.room) { player.room = index; player.steps++; }
  if (index === GOAL_I && !run.goalPending) {
    run.goalPending = true; sendPosition();
    request("goal:reached", { roundId: run.roundId }).catch(() => { if (run && !run.done) run.goalPending = false; });
  }
}
function step(dt) {
  const player = run.players[slot];
  let dx = 0, dy = 0;
  for (const key of held) { const control = CONTROL[key]; if (control) { dx += control[0]; dy += control[1]; } }
  if (dx || dy) {
    const distance = SPEED * dt, segments = Math.max(1, Math.ceil(distance / 6)), length = Math.hypot(dx, dy);
    for (let i = 0; i < segments; i++) { player.x += dx / length * distance / segments; player.y += dy / length * distance / segments; collide(player); collide(player); }
  }
  for (let i = 0; i < GAPS.length; i++) {
    if (run.doors[i]) continue;
    const gap = GAPS[i], cx = Math.max(gap.x, Math.min(player.x, gap.x + gap.w)), cy = Math.max(gap.y, Math.min(player.y, gap.y + gap.h));
    if (Math.hypot(player.x - cx, player.y - cy) >= PR + 2) continue;
    run.doors[i] = run.open.has(i) ? 1 : 2; run.flash.set(i, 1);
    socket.emit("door:discover", { roundId: run.roundId, doorId: i });
  }
  markRoom(player, true);
}
function fitCanvas() {
  const size = canvas.parentElement.clientWidth;
  if (!size) return;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(size * dpr); canvas.height = canvas.width;
}
new ResizeObserver(fitCanvas).observe(canvas.parentElement);
let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min((now - lastFrame) / 1000, 1 / 30); lastFrame = now;
  if (run) {
    const remaining = run.started - now;
    if (!run.done) {
      $("#countdown").hidden = remaining <= -450;
      $("#countdown").classList.toggle("go", remaining <= 0);
      $("#countdownValue").textContent = remaining > 0 ? String(Math.min(3, Math.ceil(remaining / 1000))) : "GO";
      $("#gamePhase").textContent = remaining > 0 ? "準備開始" : "競速進行中";
      run.elapsed = Math.max(0, -remaining);
      if (remaining <= 0 && currentView === "game" && !run.goalPending) {
        step(dt);
        if (!run.done && now - lastSent > 50) { sendPosition(); lastSent = now; }
      }
    } else $("#gamePhase").textContent = "回合結束";
    $("#clock").textContent = fmt(run.elapsed);
    for (let i = 0; i < 2; i++) $(`#p${i + 1}Steps`).textContent = `${run.players[i].steps} 步`;
    for (const [key, value] of run.flash) { const next = value - dt * 3.2; if (next <= 0) run.flash.delete(key); else run.flash.set(key, next); }
    if (currentView === "game") {
      const doors = run.showRoutes ? Int8Array.from(DOORS, (_, i) => run.open.has(i) ? 1 : 2) : run.doors;
      paintBoard(ctx, canvas.width, { doors, rooms: roomStates(doors, run.visited), visited: run.visited, players: run.players, paths: run.showRoutes ? run.paths : null, flash: run.flash });
    }
  }
  requestAnimationFrame(frame);
}
syncConnection(); requestAnimationFrame(frame);
