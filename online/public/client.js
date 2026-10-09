import { DOORS } from "./layouts.js";
import { BOARD, ROOM, WALL, PR, SPEED, START_I, GOAL_I, pos, GAPS, allPaths, buildWalls, roomStates } from "./geometry.js";
import { paintBoard } from "./renderer.js";
import { cameraTarget, followCamera } from "./vision.js";
import { trafficState } from "./traffic.js";
import { MAX_PLAYERS, PLAYER_STYLES, TEAM_STYLES } from "./players.js";
import { createDpad } from "./touch-controls.js";
import { rotationState, screenToWorld } from "./rotation.js";
import { createEliminationClient } from "./elimination-client.js";

const $ = selector => document.querySelector(selector);
const socket = window.io();
const canvas = $("#board"), ctx = canvas.getContext("2d");
canvas.tabIndex = 0;
const held = new Set();
const keyboardHeld = new Set(), touchHeld = new Set();
let dpadControls = null;
const blockedControls = new Set();
const motionPreference = matchMedia("(prefers-reduced-motion: reduce)");
let reducedMotion = motionPreference.matches;
motionPreference.addEventListener("change", event => {
  reducedMotion = event.matches;
  if (run?.rotation) $("#rotationHint").textContent = reducedMotion ? "減少動態：每 4 秒轉向 90° · 按螢幕方向移動" : "每 4 秒轉 90° · 順時針一圈 16 秒 · 按螢幕方向移動";
});
const CONTROL = { KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
let room = null, slot = -1, run = null, currentView = "home", serverOffset = 0;
let noticeTimer, settingsTimer, entryBusy = false, starting = false, lastSent = 0;
const isHost = () => room?.hostId === socket.id;
const isTeam = () => room?.settings.teamMode === true;
const fmt = ms => (Math.max(0, ms) / 1000).toFixed(2);

function syncHeld() {
  held.clear();
  for (const key of [...keyboardHeld, ...touchHeld]) if (!blockedControls.has(key)) held.add(key);
}
function clearControls(blockTouches = false) {
  keyboardHeld.clear(); touchHeld.clear(); held.clear();
  if (blockTouches) dpadControls?.blockUntilRelease();
  else dpadControls?.clear();
}

function notify(message) {
  $("#notice").textContent = message; $("#notice").hidden = false;
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { $("#notice").hidden = true; }, 4500);
}
function showView(view) {
  currentView = view; clearControls();
  for (const name of ["home", "lobby", "game"]) $(`#${name}View`).hidden = name !== view;
  if (view === "game") { fitCanvas(); if (run?.traffic) run.trafficPhase = null; }
  else clearTrafficFlash();
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
  clearQuiz();
  room = null; run = null; slot = -1; clearControls(); clearTimeout(settingsTimer);
  blockedControls.clear(); $("#trafficSignal").hidden = true; clearTrafficFlash();
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
  for (const key of ["doorMode", "layoutMode", "drawMode", "fixedLayout", "scoreToWin"]) $(`#${key}`).value = settings[key];
  $("#viewMode").checked = settings.viewMode === "scroll" || settings.viewMode === "fog";
  for (const key of ["teamMode", "shareDiscovery", "revealAfterRound"]) $(`#${key}`).checked = Boolean(settings[key]);
  for (const button of document.querySelectorAll("[data-mode]")) {
    const selected = button.dataset.mode === settings.mapMode;
    button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected));
  }
  syncSettingsDisplay();
}
function syncSettingsDisplay() {
  const elimination = $("#doorMode").value === "elimination";
  for (const id of ["teamMode", "scoreToWin", "shareDiscovery", "layoutMode", "drawMode"]) $(`#${id}`).disabled = elimination;
  for (const button of document.querySelectorAll("[data-score]")) button.disabled = elimination;
  if (elimination) { $("#teamMode").checked = false; $("#shareDiscovery").checked = false; $("#scoreToWin").value = "1"; $("#layoutMode").value = "random"; }
  const teams = $("#teamMode").checked;
  $("#winScoreHint").textContent = teams ? "先拿到目標分數的隊伍贏得整場。可輸入 1–99。" : "先拿到目標分數的人贏得整場。可輸入 1–99。";
  const coverage = $("#doorMode").value === "coverage";
  const reverse = $("#doorMode").value === "reverse", officialOnly = coverage || reverse;
  // Choosing this mode switches to official maps; other modes unlock the choice.
  $("#proceduralMode").disabled = officialOnly;
  if (officialOnly) {
    for (const button of document.querySelectorAll("[data-mode]")) {
      const selected = button.dataset.mode === "official";
      button.classList.toggle("selected", selected); button.setAttribute("aria-pressed", String(selected));
    }
  }
  const generated = $("#proceduralMode").classList.contains("selected");
  $("#officialSettings").hidden = generated;
  $("#modeDescription").textContent = generated ? "不抽選官方關卡。程式每回合生成新迷宮，沒有死路，兩條分岔都能抵達 E3。" : "使用真實佈局資料，可依官方機率抽選。";
  const scroll = $("#viewMode").checked, math = $("#doorMode").value === "math", traffic = $("#doorMode").value === "traffic";
  $("#viewDescription").textContent = scroll ? "放大盤面、鏡頭跟隨自己；沒有黑霧或牆後遮擋" : "獨立開關，可搭配任意地圖與玩法";
  $("#doorDescription").textContent = math ? "每人撞門都要回答簡單加減乘除題；即使真假已共享，仍須自己答對才能解除限制。" : "碰到未知的門，即可知道真假。";
  if (traffic) $("#doorDescription").textContent = "雙方同步紅綠燈：綠燈前進、黃燈準備停，紅燈移動就傳回 A3 起點。探門記錄保留。";
  if ($("#doorMode").value === "rotate") $("#doorDescription").textContent = "整張 5×5 迷宮順時針旋轉，每 4 秒轉 90°，一圈 16 秒。鍵盤與手機方向鍵以螢幕方向為準；可搭配官方／生成迷宮與捲軸視角。容易暈眩者請選其他玩法。";
  if (coverage) {
    $("#modeDescription").textContent = "全路線探索限定官方佈局；仍可隨機抽選或指定官方關卡。";
    $("#doorDescription").textContent = "親自走過兩條官方通關路線的所有路段，才能拿 E3 王冠。重疊路段只算一次，對手探門不會增加你的進度。";
  }
  if (reverse) {
    $("#modeDescription").textContent = "逆向神廟限定官方佈局；可隨機抽選或指定官方關卡。";
    $("#doorDescription").textContent = "從原本 E3 終點出發，跑回 A3 起點拿王冠。棋盤固定翻轉 180°，E3 在畫面下方、A3 在上方；不會持續旋轉，方向鍵以螢幕為準。";
  }
  if (elimination) {
    $("#modeDescription").textContent = generated ? "每人每段獨立生成新路線，兩條通路都能通關；最後兩人使用同一張新迷宮。" : "每人每段抽選不同官方佈局，整場不重複；最後兩人使用同一張新官方迷宮。";
    $("#doorDescription").textContent = "各自跑獨立 5×5 路線，出口走道直接接下一段，每段淘汰最後一人（晉級名額滿就淘汰尚未到達者）。領先者不必等待，剩下兩人接到共用 5×5 決賽，先拿皇冠獲勝；淘汰者可切換觀戰。";
    $("#winScoreHint").textContent = "個人淘汰，一場定勝負，不使用隊伍或累積勝利分數。";
  }
  $("#shareDiscoveryHint").textContent = teams ? math ? "只向隊友共享開關資訊；每人仍要自己答對才能通過" : "只向隊友共享真假門資訊，不傳給另一隊" : math ? "答對後共享開關資訊，但每人仍要自己答對才能通過" : "對方發現的真假門，你也看得見";
  if (elimination) $("#shareDiscoveryHint").textContent = "個人賽道不同，不共享門資訊；觀戰可看被觀戰者的探門記錄";
  const fixed = $("#layoutMode").value === "fixed";
  $("#fixedLayoutField").hidden = !fixed; $("#drawModeField").hidden = fixed;
  for (const button of document.querySelectorAll("[data-score]")) button.classList.toggle("selected", button.dataset.score === $("#scoreToWin").value);
}
function readSettings() {
  for (const id of ["scoreToWin", "fixedLayout"]) {
    const input = $(`#${id}`);
    if (!input.checkValidity() || !input.value) { input.reportValidity(); throw new Error(id === "scoreToWin" ? "勝利分數請輸入 1–99 的整數。" : "佈局編號請輸入 0–124。"); }
  }
  return { mapMode: $("#proceduralMode").classList.contains("selected") ? "procedural" : "official", viewMode: $("#viewMode").checked ? "scroll" : "standard", doorMode: $("#doorMode").value, teamMode: $("#teamMode").checked, drawMode: $("#drawMode").value, layoutMode: $("#layoutMode").value, fixedLayout: Number($("#fixedLayout").value), scoreToWin: Number($("#scoreToWin").value), shareDiscovery: $("#shareDiscovery").checked, revealAfterRound: $("#revealAfterRound").checked };
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
  if (button.dataset.mode === "procedural" && ["coverage", "reverse"].includes($("#doorMode").value)) return;
  for (const option of document.querySelectorAll("[data-mode]")) {
    const selected = option === button; option.classList.toggle("selected", selected); option.setAttribute("aria-pressed", String(selected));
  }
  queueSettings();
});
for (const button of document.querySelectorAll("[data-score]")) button.addEventListener("click", () => { $("#scoreToWin").value = button.dataset.score; queueSettings(); });
for (let i = 0; i < MAX_PLAYERS; i++) {
  const select = document.createElement("select");
  select.id = `seat${i}Team`; select.className = "team-select"; select.hidden = true;
  TEAM_STYLES.forEach((team, value) => select.add(new Option(team.name, String(value))));
  $(`#seat${i}`).insertBefore(select, $(`#seat${i}State`));
  select.addEventListener("change", async () => {
    const player = room?.players.find(p => p.slot === i);
    if (!player) return;
    const team = Number(select.value); select.disabled = true;
    try { await request("team:choose", { playerId: player.id, team }); }
    catch (error) { notify(error.message); }
    finally { if (room) updateRoom(room); }
  });
}
function updateTeamScores(scores = room?.teamScores ?? [0, 0], winnerTeam = -1) {
  $("#teamScoreboard").hidden = !isTeam();
  for (let team = 0; team < TEAM_STYLES.length; team++) {
    $(`#team${team}Score`).textContent = scores[team];
    $(`#team${team}Members`).textContent = room.players.filter(p => p.team === team).map(p => p.name).join("、") || "尚無隊員";
    $(`#team${team}Score`).parentElement.classList.toggle("winner", team === winnerTeam);
  }
}
function updateRoom(data) {
  const previousStatus = room?.status;
  room = data; slot = room.players.find(player => player.id === socket.id)?.slot ?? slot;
  $("#roomBadge").hidden = $("#leaveRoom").hidden = false;
  $("#roomBadge").textContent = room.code; $("#roomCode").textContent = room.code;
  $("#seatCount").textContent = `${room.players.length} / ${MAX_PLAYERS}`;
  $(".roster-note").textContent = room.settings.doorMode === "reverse" ? "2–4 人共用官方迷宮，從 E3 出發。第一個跑回 A3 王冠房間的人拿下一分。" : "2–4 人共用一張迷宮。至少兩人即可開局，第一個符合玩法條件並進入 E3 王冠房間的人拿下一分。";
  if (isTeam()) $(".roster-note").textContent = "藍隊 vs 紅隊：任一隊員符合玩法條件並拿到王冠，隊伍就得一分。開局前可自行選隊，房主可調整所有人；換隊會重置比分，兩隊都必須有人。";
  if (room.settings.doorMode === "elimination") $(".roster-note").textContent = "2–4 人個人淘汰賽：各跑各的不同路線，逐段淘汰最後一人，再由最後兩人在同一張新迷宮決勝。兩人開局直接進入決賽。";
  $("#scoreboard").style.setProperty("--active-players", Math.max(2, room.players.length));
  for (let i = 0; i < MAX_PLAYERS; i++) {
    const player = room.players.find(p => p.slot === i);
    $(`#seat${i}Name`).textContent = player?.name || "等待冒險者";
    $(`#seat${i}`).classList.toggle("empty", !player);
    $(`#seat${i}State`).textContent = player ? "已加入" : "等待中";
    const select = $(`#seat${i}Team`);
    select.hidden = !player || !isTeam(); select.value = String(player?.team ?? 0);
    select.disabled = starting || room.status === "playing" || !player || (!isHost() && player.id !== socket.id);
    select.setAttribute("aria-label", `${player?.name || `${i + 1}P`}的隊伍`);
    select.dataset.team = String(player?.team ?? 0);
    $(`#scorePlayer${i}`).hidden = !player;
    $(`#p${i + 1}Name`).textContent = `${player?.name || "等待中"}${slot === i ? "（你）" : ""}${isTeam() && player ? ` · ${TEAM_STYLES[player.team].name}` : ""}`;
    $(`#p${i + 1}Score`).title = isTeam() ? "個人取得皇冠次數（勝負以隊伍分數為準）" : "個人分數";
    $(`#p${i + 1}Score`).dataset.unit = isTeam() ? " 冠" : "";
    $(`#p${i + 1}Score`).textContent = room.scores[i];
    if (room.settings.doorMode !== "elimination") { delete $(`#scorePlayer${i}`).dataset.eliminated; $(`#p${i + 1}Score`).style.fontSize = ""; }
  }
  updateTeamScores(room.teamScores, run?.done ? run.winnerTeam : -1);
  $("#lobbySubtitle").textContent = isHost() ? "你是房主。選好規則，邀請朋友一起出發。" : "你是挑戰者。房主會設定規則並開始對戰。";
  $("#hostOnlyNote").textContent = isHost() ? "房主設定" : "由房主設定";
  $("#hostSettings").disabled = !isHost() || room.status === "playing";
  $("#settingsNote").textContent = room.status === "playing" ? "回合進行中，設定已鎖定；回合結束後可修改。" : "設定自動同步給對手；修改規則會重置比分。";
  applySettings(room.settings);
  $("#matchTarget").textContent = `${isTeam() ? "隊伍" : ""}先得 ${room.settings.scoreToWin} 分獲勝`;
  if (room.settings.doorMode === "elimination") $("#matchTarget").textContent = "逐段淘汰 · 一場定勝負";
  const teamsReady = !isTeam() || [0, 1].every(team => room.players.some(p => p.team === team));
  $("#startRound").disabled = starting || (room.status !== "playing" && (!isHost() || room.players.length < 2 || !teamsReady));
  $("#startRound").textContent = room.status === "playing" ? "返回對戰 →" : room.players.length < 2 ? "等待對手加入（至少 2 人）" : !teamsReady ? "請讓藍隊與紅隊都有人" : isHost() ? (room.roundNumber ? "繼續對戰 →" : `開始 ${isTeam() ? "兩隊" : room.players.length + " 人"}對戰 →`) : "等待房主開始";
  if (room.status === "lobby" && (run || previousStatus === "ended" || previousStatus === "playing")) {
    if (previousStatus === "playing") notify("有玩家離開，回合已取消、比分已重置。");
    clearQuiz(); run = null; blockedControls.clear(); $("#trafficSignal").hidden = true; showView("lobby");
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

const mathDialog = $("#mathChallenge");
function clearTrafficFlash() {
  $("#trafficFlash").classList.remove("active");
}
function flashTraffic(phase) {
  const overlay = $("#trafficFlash");
  overlay.dataset.phase = phase;
  overlay.classList.remove("active");
  // One soft pulse per phase change, never a continuously flashing screen.
  void overlay.offsetWidth;
  overlay.classList.add("active");
}
// Only a correct answer or the end of the round can dismiss the question.
mathDialog.addEventListener("cancel", event => event.preventDefault());
function updateMathDoorStatus(game, doorId) {
  const state = game.doors[doorId];
  $("#mathDoorStatus").textContent = state ? `已共享：${state === 1 ? "真門（開）" : "假門（關）"}。仍須自己答對才能繼續。` : "答對後揭曉這扇門的真假。";
}
function clearQuiz() {
  if (run) run.quiz = null;
  clearControls();
  if (mathDialog.open) mathDialog.close();
  mathDialog.hidden = true; $("#mathAnswer").value = "";
}
function revealMathDoor(game, data) {
  if (run !== game || game.done) return;
  game.doors[data.doorId] = data.state; game.flash.set(data.doorId, 1);
  game.solved.add(data.doorId);
  if (data.state === 1) game.unlocked.add(data.doorId);
  game.walls = buildWalls(game.unlocked);
  if (game.quiz?.doorId === data.doorId) { clearQuiz(); canvas.focus({ preventScroll: true }); }
  const subject = data.by !== undefined && data.by !== slot ? "對手答對了" : "答對了";
  notify(data.state === 1 ? `${subject}！這是真門，現在可以通過。` : `${subject}！這是假門，請另找路線。`);
}
async function beginQuiz(doorId) {
  const game = run;
  if (!game || game.done) return;
  const loading = { doorId, loading: true };
  game.quiz = loading; clearControls(); sendPosition();
  $("#mathQuestion").textContent = "出題中…";
  $("#mathFeedback").textContent = "正在取得題目，計時仍繼續。";
  $("#mathFeedback").classList.remove("incorrect");
  $("#mathAnswer").disabled = true; $("#submitMath").disabled = true;
  $("#submitMath").textContent = "確認答案 →";
  updateMathDoorStatus(game, doorId);
  mathDialog.hidden = false;
  if (!mathDialog.open) mathDialog.showModal();
  $("#mathTitle").focus({ preventScroll: true });
  try {
    const data = await request("door:challenge", { roundId: game.roundId, doorId });
    if (run !== game || game.done || game.quiz !== loading) return;
    if (data.solved) { revealMathDoor(game, data); return; }
    game.quiz = { ...data.challenge, loading: false };
    $("#mathQuestion").textContent = data.challenge.question;
    $("#mathFeedback").textContent = data.challenge.attempts ? `已作答 ${data.challenge.attempts} 次，可以繼續重試。` : "請輸入整數答案，答錯可一直重試。";
    $("#mathAnswer").disabled = false; $("#submitMath").disabled = false;
    $("#mathAnswer").value = "";
    if (currentView === "game") $("#mathAnswer").focus();
  } catch (error) {
    if (run !== game || game.done || game.quiz !== loading) return;
    game.quiz = { doorId, error: true };
    $("#mathFeedback").textContent = error.message;
    $("#mathFeedback").classList.add("incorrect");
    $("#submitMath").disabled = false; $("#submitMath").textContent = "重新取得題目";
  }
}
$("#mathForm").addEventListener("submit", async event => {
  event.preventDefault();
  const game = run, quiz = game?.quiz;
  if (!quiz || game.done || quiz.loading || quiz.submitting) return;
  if (quiz.error) { beginQuiz(quiz.doorId); return; }
  quiz.submitting = true;
  $("#submitMath").disabled = true; $("#mathAnswer").disabled = true;
  try {
    const data = await request("door:answer", { roundId: game.roundId, challengeId: quiz.id, answer: $("#mathAnswer").value });
    if (run !== game || game.done || game.quiz !== quiz) return;
    if (data.correct) { revealMathDoor(game, data); return; }
    quiz.submitting = false;
    $("#mathFeedback").textContent = `還不對，第 ${data.attempts} 次作答。再試一次，答對才能解除限制。`;
    $("#mathFeedback").classList.add("incorrect");
    $("#mathAnswer").disabled = false; $("#submitMath").disabled = false;
    $("#mathAnswer").value = ""; $("#mathAnswer").focus();
  } catch (error) {
    if (run !== game || game.done || game.quiz !== quiz) return;
    // Retrieving the same door also recovers a lost successful answer ACK.
    quiz.error = true; quiz.submitting = false;
    $("#mathFeedback").textContent = error.message;
    $("#mathFeedback").classList.add("incorrect");
    $("#submitMath").disabled = false; $("#submitMath").textContent = "重新取得題目";
  }
});

socket.on("round:start", data => {
  if (!room) return;
  clearQuiz();
  clearControls(); blockedControls.clear(); clearTrafficFlash(); lastSent = 0;
  // Convert the shared server start time to a monotonic local deadline.
  const wait = Math.max(0, data.startsAt - (Date.now() + serverOffset));
  run = { ...data, open: new Set(data.openDoors), walls: buildWalls(new Set(data.openDoors)), doors: new Int8Array(DOORS.length), visited: new Uint8Array(25), flash: new Map(), players: Array(MAX_PLAYERS).fill(null), started: performance.now() + wait, elapsed: 0, done: false, goalPending: false, showRoutes: false };
  run.reverse = data.settings.doorMode === "reverse";
  run.startI = data.startI ?? (run.reverse ? GOAL_I : START_I);
  run.goalI = data.goalI ?? (run.reverse ? START_I : GOAL_I);
  for (const player of data.players) run.players[player.slot] = { ...player, room: run.startI };
  run.visited[run.startI] = 1;
  run.paths = allPaths(run.open);
  if (run.reverse) run.paths = run.paths.map(path => [...path].reverse());
  run.coveredDoors = new Set(); run.coverageReady = false;
  updateCoverageDisplay();
  run.unlocked = new Set(); run.solved = new Set(); run.quiz = null;
  if (data.settings.doorMode === "math") run.walls = buildWalls(run.unlocked);
  run.camera = cameraTarget(run.players[slot]);
  run.rotationAngle = run.reverse ? Math.PI : data.rotation ? 0 : undefined;
  $("#rotationSignal").hidden = !(data.rotation || run.reverse);
  $("#rotationTitle").textContent = run.reverse ? "逆向神廟 · 固定 180°" : "旋轉神廟 · 順時針";
  $(".rotation-icon").textContent = run.reverse ? "⇵" : "↻";
  $("#rotationHint").textContent = run.reverse ? "官方限定 · E3 出發 → A3 王冠 · 按螢幕方向移動" : reducedMotion ? "減少動態：每 4 秒轉向 90° · 按螢幕方向移動" : "每 4 秒轉 90° · 順時針一圈 16 秒 · 按螢幕方向移動";
  const scroll = data.settings.viewMode === "scroll" || data.settings.viewMode === "fog";
  $("#gameModeLabel").textContent = scroll ? "SCROLLING CAMERA" : data.settings.mapMode === "procedural" ? "GENERATED MAZE" : "OFFICIAL MAZE";
  $("#raceTitle").textContent = scroll ? "跟著鏡頭前進。" : "選你的路。";
  $("#raceDescription").textContent = scroll ? "盤面放大，鏡頭跟著你移動。畫面內的房間與對手都看得見，沒有黑霧遮擋；未知門仍要碰過才揭曉。" : "摸清真假門，選好你的路線。找到王冠，拿下這一分。";
  if (data.settings.doorMode === "math") {
    $("#gameModeLabel").textContent = scroll ? "MATH GATES · SCROLLING" : "MATH GATES";
    $("#raceTitle").textContent = "答對，才揭曉。";
    $("#raceDescription").textContent = "撞門先答加減乘除題，答錯可一直重試。即使已共享真假資訊，仍要自己答對才能通過；計時與對手不會暫停。";
  }
  if (data.settings.doorMode === "coverage") {
    $("#gameModeLabel").textContent = scroll ? "FULL EXPLORATION · SCROLLING" : "FULL EXPLORATION · OFFICIAL";
    $("#raceTitle").textContent = "走遍兩條路。";
    $("#raceDescription").textContent = "親自走過兩條官方通關路線的每個路段，王冠才會解鎖。可來回探索，重複路段只算一次；對手的足跡不會計入你的進度。";
  }
  if (data.rotation) {
    $("#gameModeLabel").textContent = scroll ? "ROTATING TEMPLE · SCROLLING" : "ROTATING TEMPLE";
    $("#raceTitle").textContent = "神廟在轉，別迷失方向。";
    $("#raceDescription").textContent = "整張棋盤、門與王冠一起旋轉。按右仍往螢幕右側走，手機滑動方向鍵也一樣；真假門照常共享，第一個抵達 E3 王冠的人得分。";
  }
  if (run.reverse) {
    $("#gameModeLabel").textContent = scroll ? "REVERSE TEMPLE · SCROLLING" : "REVERSE TEMPLE · OFFICIAL";
    $("#raceTitle").textContent = "從終點，跑回起點。";
    $("#raceDescription").textContent = "沿官方路線逆向探索，從畫面下方的 E3 出發，跑回上方的 A3 拿王冠。整張棋盤固定翻轉 180°，不會繼續轉動；探門情報仍可共享。";
  }
  $("#trafficSignal").hidden = !data.traffic;
  if (data.traffic) {
    $("#gameModeLabel").textContent = scroll ? "RED LIGHT · SCROLLING" : "RED LIGHT / GREEN LIGHT";
    $("#raceTitle").textContent = "紅燈停，綠燈走。";
    $("#raceDescription").textContent = "所有玩家共用燈號，黃燈預告後就要停下。紅燈時按移動鍵也算違規，會被傳回起點；已探過的門保留。";
  }
  if (data.settings.teamMode) {
    $("#gameModeLabel").textContent += " · TEAMS";
    $("#raceDescription").textContent += ` 任一隊員通關就為隊伍加一分。${data.settings.shareDiscovery ? "共享探門只傳給隊友。" : "本場不共享探門情報。"}數學答題與探索進度仍各自完成。`;
  }
  canvas.setAttribute("aria-label", run.reverse ? "逆向神廟，棋盤固定旋轉180度，從下方 E3 出發，回到上方 A3 拿王冠" : data.rotation ? "旋轉神廟，5×5 棋盤順時針旋轉，方向鍵以螢幕方向為準" : scroll ? "捲軸迷宮，放大鏡頭跟隨你的角色，沒有黑霧遮擋" : "迷宮對戰盤面");
  $("#roundTitle").textContent = `第 ${data.roundNumber} 回合`;
  $("#raceInfo").hidden = false; $("#resultInfo").hidden = true;
  $("#countdown").hidden = false; $("#countdownValue").textContent = "3";
  $("#yourSeat").textContent = `你是 ${slot + 1}P · ${PLAYER_STYLES[slot].name}${data.settings.teamMode ? ` · ${TEAM_STYLES[run.players[slot].team].name}` : ""}`;
  $("#yourSeat").className = `your-seat ${PLAYER_STYLES[slot].className}`;
  for (let i = 0; i < MAX_PLAYERS; i++) { $(`#p${i + 1}Score`).textContent = data.scores[i]; $(`#scorePlayer${i}`).classList.remove("winner"); }
  updateTeamScores(data.teamScores);
  $("#eliminationPanel").hidden = !data.elimination;
  $(".dpad").hidden = false;
  if (data.elimination) {
    run.eliminationRace = createEliminationClient({ game: run, slot, canvas, ctx, socket, notify, clearControls, getRoom: () => room });
    $("#gameModeLabel").textContent = "SEAMLESS ELIMINATION RACE";
    $("#raceTitle").textContent = "向前跑，別成為最後一人。";
    $("#raceDescription").textContent = "每人跑不同的 5×5 路線，到 E3 就晉級，往上穿過走道直接進入下一段。每段最後一人淘汰並開放觀戰；領先者可以繼續往前跑，最後兩人在共用新迷宮爭奪王冠。";
    canvas.setAttribute("aria-label", "無縫淘汰賽道，獨立5乘5迷宮上下銜接，最後兩人共用決賽迷宮");
  }
  showView("game");
});
socket.on("elimination:state", data => { if (run?.eliminationRace && !run.done && data.roundId === run.roundId) run.eliminationRace.update(data); });
socket.on("elimination:correction", data => { if (run?.eliminationRace && !run.done && data.roundId === run.roundId) run.eliminationRace.correct(data); });
socket.on("player:state", data => {
  if (!run || run.done || data.roundId !== run.roundId || data.slot === slot) return;
  if (!run.players[data.slot]) return;
  Object.assign(run.players[data.slot], { x: data.x, y: data.y, steps: data.steps });
  if (run.settings.shareDiscovery && (!run.settings.teamMode || run.players[data.slot].team === run.players[slot].team)) markRoom(run.players[data.slot], false);
});
socket.on("player:reset", data => {
  if (!run || (!run.traffic && run.settings.doorMode !== "coverage") || run.done || data.roundId !== run.roundId) return;
  const player = run.players[data.slot];
  if (!player || data.revision <= player.revision) return;
  const changed = data.revision > player.revision;
  Object.assign(player, { x: data.x, y: data.y, room: data.room ?? run.startI, steps: data.steps, revision: data.revision });
  if (data.slot === slot) {
    for (const key of keyboardHeld) blockedControls.add(key);
    clearControls(true); run.goalPending = false; run.camera = cameraTarget(player);
    if (changed) notify(run.traffic ? "紅燈移動！已傳回 A3 起點，放開方向鍵後再出發。" : "位置已校正，請沿著真門行走，放開方向鍵後再出發。");
  } else if (changed) notify(`${data.slot + 1}P 紅燈移動，被傳回起點！`);
});
function updateCoverageDisplay() {
  const enabled = run?.settings.doorMode === "coverage";
  $("#coveragePanel").hidden = !enabled;
  if (!enabled) return;
  const completed = run.coveredDoors.size, total = run.coverageTotal;
  $("#coverageCount").textContent = `${completed} / ${total} 路段`;
  $("#coverageProgress").max = Math.max(1, total); $("#coverageProgress").value = completed;
  $("#coverageStatus").textContent = run.coverageReady ? "王冠已解鎖 · 前往 E3！" : "王冠鎖定 · 兩條路線都要親自走過";
  $("#coveragePanel").classList.toggle("complete", run.coverageReady);
}
socket.on("route:progress", data => {
  if (!run || run.done || run.settings.doorMode !== "coverage" || data.roundId !== run.roundId) return;
  const wasReady = run.coverageReady;
  run.coveredDoors = new Set(data.doorIds); run.coverageReady = data.ready;
  updateCoverageDisplay();
  if (!wasReady && data.ready) notify("所有路段都走過了！王冠已解鎖，前往 E3 拿下這一分。");
});
socket.on("door:discover", data => {
  if (!run || run.done || data.roundId !== run.roundId) return;
  if (run.settings.doorMode === "math") {
    if (data.mathSolved) {
      // Shared knowledge never solves another player's question or unlocks it.
      run.doors[data.doorId] = data.state; run.flash.set(data.doorId, 1);
      if (run.quiz?.doorId === data.doorId) updateMathDoorStatus(run, data.doorId);
      if (data.by !== slot) notify(`${data.by + 1}P 答對了：${data.state === 1 ? "真門（開）" : "假門（關）"}。你仍需答對自己的題目。`);
    }
    return;
  }
  run.doors[data.doorId] = data.state; run.flash.set(data.doorId, 1);
});
socket.on("round:end", data => {
  if (!run || data.roundId !== run.roundId) return;
  clearQuiz();
  clearTrafficFlash();
  run.done = true; run.elapsed = data.elapsedMs; clearControls();
  run.eliminationRace?.finish();
  run.rotationAngle = run.reverse ? Math.PI : undefined; $("#rotationSignal").hidden = !run.reverse;
  for (const player of data.players) Object.assign(run.players[player.slot], player);
  run.showRoutes = run.settings.revealAfterRound;
  $("#countdown").hidden = true; $("#raceInfo").hidden = true; $("#resultInfo").hidden = false;
  const teams = run.settings.teamMode, won = teams ? data.winnerTeam === run.players[slot].team : data.winner === slot;
  const matchDone = teams ? data.matchWinnerTeam !== -1 : data.matchWinner !== -1;
  run.winnerTeam = data.winnerTeam;
  const name = room.players.find(p => p.slot === data.winner)?.name || `${data.winner + 1}P`;
  $("#resultKicker").textContent = matchDone ? "MATCH COMPLETE" : "ROUND COMPLETE";
  $("#resultTitle").textContent = matchDone ? won ? "你贏得整場！" : "對手贏得整場" : won ? "這一分，你的。" : "對手先到一步。";
  if (teams) $("#resultTitle").textContent = matchDone ? won ? "你的隊伍贏得整場！" : "另一隊贏得整場" : won ? "你的隊伍拿下一分！" : "另一隊先到一步。";
  const scores = teams ? TEAM_STYLES.map((team, i) => `${team.name} ${data.teamScores[i]}`).join(" / ") : room.players.slice().sort((a, b) => a.slot - b.slot).map(player => `${player.slot + 1}P ${data.scores[player.slot]}`).join(" / ");
  $("#resultDescription").textContent = `${name} ${run.reverse ? "先跑回 A3 並取得王冠" : "先抵達王冠"}${teams ? `，為${TEAM_STYLES[data.winnerTeam].name}加一分` : ""}，${matchDone ? `${teams ? TEAM_STYLES[data.winnerTeam].name : ""}率先拿下 ${run.settings.scoreToWin} 分。` : `目前比分 ${scores}。`}`;
  if (data.elimination) {
    $("#resultTitle").textContent = won ? "你是淘汰賽冠軍！" : `${name} 贏得淘汰賽！`;
    $("#resultDescription").textContent = `決賽先到 E3 王冠，整場結束。${data.rankings.map(({ slot: playerSlot, rank }) => `第 ${rank} 名：${room.players.find(p => p.slot === playerSlot)?.name || `${playerSlot + 1}P`}`).join(" / ")}`;
  }
  $("#resultTime").textContent = `${fmt(data.elapsedMs)} 秒`; $("#resultSteps").textContent = `${data.steps} 步`;
  $("#routeStat").hidden = $("#toggleRoutes").hidden = !run.settings.revealAfterRound;
  $("#routeLengths").textContent = `${data.routeLengths?.join(" / ") || "—"} 步`;
  $("#toggleRoutes").textContent = "隱藏路線";
  $("#nextRound").hidden = !isHost(); $("#guestWait").hidden = isHost();
  $("#nextRound").textContent = matchDone ? "再來一場 →" : "下一回合 →";
  for (let i = 0; i < MAX_PLAYERS; i++) { $(`#p${i + 1}Score`).textContent = data.scores[i]; $(`#scorePlayer${i}`).classList.toggle("winner", teams ? run.players[i]?.team === data.winnerTeam : i === data.winner); }
  updateTeamScores(data.teamScores, data.winnerTeam);
  showView("game");
});

addEventListener("keydown", event => {
  if (currentView !== "game" || run?.quiz || !CONTROL[event.code] || event.target.closest("input, select, textarea") || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault(); keyboardHeld.add(event.code); syncHeld();
});
addEventListener("keyup", event => { keyboardHeld.delete(event.code); blockedControls.delete(event.code); syncHeld(); });
addEventListener("blur", () => { clearControls(); blockedControls.clear(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) clearControls(); });
dpadControls = createDpad($(".dpad"), {
  canPress: () => currentView === "game" && run && !run.done && !run.quiz,
  onChange: keys => { touchHeld.clear(); for (const key of keys) touchHeld.add(key); syncHeld(); },
});
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
  socket.emit("player:state", { roundId: run.roundId, x, y, steps, revision: run.players[slot].revision, ...(run.traffic ? { moving: held.size > 0, trafficIndex: trafficState(run.traffic, run.elapsed).index } : {}) });
}
function markRoom(player, local) {
  const c = Math.floor((player.x - WALL) / (ROOM + WALL)), r = Math.floor((player.y - WALL) / (ROOM + WALL));
  if (r < 0 || r > 4 || c < 0 || c > 4) return;
  if (player.x > pos(c) + ROOM || player.y > pos(r) + ROOM) return;
  const index = r * 5 + c; run.visited[index] = 1;
  if (!local) return;
  const entered = index !== player.room;
  if (entered) { player.room = index; player.steps++; }
  if (run.settings.doorMode === "coverage") {
    if (entered) sendPosition();
    if (!run.coverageReady) {
      if (entered && index === run.goalI) notify("王冠還沒解鎖！繼續探索另一條路線，走完所有路段再來。");
      return;
    }
  }
  if (index === run.goalI && !run.goalPending) {
    const game = run;
    run.goalPending = true; sendPosition();
    request("goal:reached", { roundId: run.roundId, revision: player.revision }).catch(() => { if (run === game && !game.done) game.goalPending = false; });
  }
}
function step(dt) {
  const player = run.players[slot];
  let dx = 0, dy = 0;
  for (const key of held) { const control = CONTROL[key]; if (control) { dx += control[0]; dy += control[1]; } }
  if (Number.isFinite(run.rotationAngle)) {
    const world = screenToWorld(dx, dy, run.rotationAngle);
    dx = world.x; dy = world.y;
  }
  // Still send movement intent to the server: pushing into a wall counts too.
  if (run.traffic && trafficState(run.traffic, run.elapsed).phase === "red") return;
  if (dx || dy) {
    const distance = SPEED * dt, segments = Math.max(1, Math.ceil(distance / 6)), length = Math.hypot(dx, dy);
    for (let i = 0; i < segments; i++) { player.x += dx / length * distance / segments; player.y += dy / length * distance / segments; collide(player); collide(player); }
  }
  for (let i = 0; i < GAPS.length; i++) {
    if (run.settings.doorMode === "math" ? run.solved.has(i) : run.doors[i]) continue;
    const gap = GAPS[i], cx = Math.max(gap.x, Math.min(player.x, gap.x + gap.w)), cy = Math.max(gap.y, Math.min(player.y, gap.y + gap.h));
    if (Math.hypot(player.x - cx, player.y - cy) >= PR + 2) continue;
    if (run.settings.doorMode === "math") { beginQuiz(i); break; }
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
      $("#gamePhase").textContent = remaining > 0 ? "準備開始" : run.quiz ? "答題中 · 計時繼續" : "競速進行中";
      run.elapsed = Math.max(0, -remaining);
      if (run.rotation) run.rotationAngle = rotationState(run.rotation, run.elapsed, reducedMotion).angle;
      if (!run.eliminationRace && remaining <= 0 && currentView === "game" && !run.goalPending) {
        if (!run.quiz) step(dt);
        if (!run.done && now - lastSent > 50) { sendPosition(); lastSent = now; }
      }
    } else $("#gamePhase").textContent = "回合結束";
    $("#clock").textContent = fmt(run.elapsed);
    if (run.eliminationRace) {
      run.eliminationRace.frame({ dt, now, held, controls: CONTROL, play: remaining <= 0 && currentView === "game", draw: currentView === "game", reducedMotion });
      requestAnimationFrame(frame); return;
    }
    if (run.reverse) {
      canvas.dataset.rotation = "180"; $("#rotationAngle").textContent = "180°";
    } else if (run.rotation && !run.done) {
      const signal = rotationState(run.rotation, run.elapsed, reducedMotion);
      canvas.dataset.rotation = String(signal.degrees);
      $("#rotationAngle").textContent = `${Math.floor(signal.degrees)}°`;
    } else delete canvas.dataset.rotation;
    if (run.traffic) {
      const signal = trafficState(run.traffic, run.elapsed), phase = run.done ? "done" : remaining > 0 ? "ready" : signal.phase;
      if (phase !== run.trafficPhase) {
        run.trafficPhase = phase;
        if (currentView === "game" && ["green", "yellow", "red"].includes(phase)) flashTraffic(phase);
        else clearTrafficFlash();
      }
      $("#trafficSignal").dataset.phase = phase;
      const labels = { ready: "準備開始", green: "綠燈 · 可以前進", yellow: "黃燈 · 準備停下", red: "紅燈 · 不要移動", done: "回合結束" };
      if ($("#trafficLabel").textContent !== labels[phase]) $("#trafficLabel").textContent = labels[phase];
      $("#trafficCountdown").textContent = phase === "ready" || phase === "done" ? "—" : `${(signal.remaining / 1000).toFixed(1)}s`;
    }
    for (let i = 0; i < MAX_PLAYERS; i++) $(`#p${i + 1}Steps`).textContent = `${run.players[i]?.steps ?? 0} 步`;
    for (const [key, value] of run.flash) { const next = value - dt * 3.2; if (next <= 0) run.flash.delete(key); else run.flash.set(key, next); }
    if (currentView === "game") {
      const localPlayer = run.players[slot];
      run.camera = followCamera(run.camera, localPlayer, dt, reducedMotion);
      const scroll = ["scroll", "fog"].includes(run.settings.viewMode) && !run.showRoutes;
      canvas.dataset.view = scroll ? "scroll" : "overview";
      $("#scrollBadge").hidden = !scroll;
      $("#boardHint").textContent = scroll ? `${String.fromCharCode(69 - Math.floor(localPlayer.room / 5))}${localPlayer.room % 5 + 1} · 王冠位於 E3 ↑` : "A3 出發 → E3 王冠";
      if (run.rotation && !run.done) $("#boardHint").textContent = `${scroll ? String.fromCharCode(69 - Math.floor(localPlayer.room / 5)) + (localPlayer.room % 5 + 1) + " · " : ""}E3 王冠 · 方向鍵以螢幕為準`;
      if (run.reverse) $("#boardHint").textContent = `${scroll ? String.fromCharCode(69 - Math.floor(localPlayer.room / 5)) + (localPlayer.room % 5 + 1) + " · " : ""}E3 出發 → A3 王冠 · 固定 180°`;
      const doors = run.showRoutes ? Int8Array.from(DOORS, (_, i) => run.open.has(i) ? 1 : 2) : run.doors;
      paintBoard(ctx, canvas.width, { doors, rooms: roomStates(doors, run.visited), visited: run.visited, players: run.players, teamMode: run.settings.teamMode, startI: run.startI, goalI: run.goalI, paths: run.showRoutes ? run.paths : null, coveredDoors: run.settings.doorMode === "coverage" && !run.showRoutes ? run.coveredDoors : null, goalLocked: run.settings.doorMode === "coverage" && !run.coverageReady && !run.done, flash: run.flash, rotation: run.rotationAngle, fixedRotation: run.reverse, camera: scroll ? run.camera : null });
    }
  }
  requestAnimationFrame(frame);
}
syncConnection(); requestAnimationFrame(frame);
