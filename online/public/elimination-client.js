import { BOARD, WALL, DOOR, PR, SPEED, GAPS, allPaths, roomStates } from "./geometry.js";
import { paintBoard } from "./renderer.js";
import { stageOffset, stageAt, mapFor, trackWalls, roomAt, CONNECTOR, START_I, GOAL_I } from "./elimination-geometry.js";
import { PLAYER_STYLES } from "./players.js";

const $ = selector => document.querySelector(selector);
export function createEliminationClient({ game, slot, canvas, ctx, socket, notify, clearControls, getRoom }) {
  const plan = game.elimination.plan, finalStage = plan.length - 1;
  let snapshot, watched = slot, camera = null, lastSent = 0, walls, qualified = -2;
  const tiles = plan.map(() => {
    const tile = document.createElement("canvas"); tile.width = tile.height = BOARD;
    return { tile, ctx: tile.getContext("2d") };
  });
  const cache = new Map();
  function knowledge(stage, owner) {
    const key = `${owner}:${stage}`;
    if (!cache.has(key)) cache.set(key, { doors: new Int8Array(GAPS.length), visited: new Uint8Array(25) });
    const state = cache.get(key), player = game.players[owner], map = mapFor(plan, stage, owner), open = new Set(map.openDoors);
    for (const id of player.known[stage]) state.doors[id] = open.has(id) ? 1 : 2;
    for (const id of player.visited[stage]) state.visited[id] = 1;
    return state;
  }
  function update(data, first = false) {
    const wasEliminated = game.players[slot]?.eliminated;
    snapshot = data;
    for (const state of data.players) {
      const existing = game.players[state.slot];
      const predicted = existing && state.slot === slot && !state.eliminated && !state.finished && !first ? { x: existing.x, y: existing.y, stage: existing.stage } : null;
      game.players[state.slot] = { ...state, ...predicted };
    }
    const own = game.players[slot];
    if (!wasEliminated && own.eliminated && !first) { clearControls(true); notify(`你在第 ${own.eliminatedAt + 1} 段被淘汰，可切換觀戰其他玩家。`); }
    if (!own.eliminated && !game.done) watched = slot;
    else if (!game.players[watched] || (game.players[watched].eliminated && !game.done)) {
      watched = data.players.filter(p => !p.eliminated).sort((a, b) => b.qualified - a.qualified || b.stage - a.stage || a.y - b.y)[0]?.slot ?? slot;
      camera = null;
    }
    const select = $("#spectateTarget"), permitted = own.eliminated || game.done;
    $("#spectateField").hidden = !permitted;
    const choices = data.players.filter(p => game.done || !p.eliminated);
    const ids = choices.map(p => p.slot).join(",");
    if (select.dataset.slots !== ids) {
      select.dataset.slots = ids;
      select.replaceChildren(...choices.map(p => new Option(`${p.slot + 1}P · ${getRoom().players.find(r => r.slot === p.slot)?.name || "玩家"}`, String(p.slot))));
    }
    select.value = String(watched);
  }
  $("#spectateTarget").onchange = event => {
    if (!game.players[slot].eliminated && !game.done) return;
    watched = Number(event.target.value); camera = null;
  };
  update(game.elimination, true);
  function collide(player) {
    for (const wall of walls) {
      const cx = Math.max(wall.x, Math.min(player.x, wall.x + wall.w)), cy = Math.max(wall.y, Math.min(player.y, wall.y + wall.h));
      const dx = player.x - cx, dy = player.y - cy, d2 = dx * dx + dy * dy;
      if (d2 >= PR * PR) continue;
      if (d2 > 1e-6) {
        const distance = Math.sqrt(d2); player.x = cx + dx / distance * PR; player.y = cy + dy / distance * PR;
      } else {
        const distances = [player.x - wall.x, wall.x + wall.w - player.x, player.y - wall.y, wall.y + wall.h - player.y];
        const index = distances.indexOf(Math.min(...distances));
        if (index === 0) player.x = wall.x - PR; else if (index === 1) player.x = wall.x + wall.w + PR;
        else if (index === 2) player.y = wall.y - PR; else player.y = wall.y + wall.h + PR;
      }
    }
  }
  function frame({ dt, now, held, controls, play, draw, reducedMotion }) {
    const own = game.players[slot];
    if (play && !game.done && !own.eliminated && !own.finished) {
      if (qualified !== own.qualified) { qualified = own.qualified; walls = trackWalls(plan, slot, qualified); }
      let dx = 0, dy = 0;
      for (const key of held) { const value = controls[key]; if (value) { dx += value[0]; dy += value[1]; } }
      if (dx || dy) {
        const distance = SPEED * dt, pieces = Math.max(1, Math.ceil(distance / 4)), length = Math.hypot(dx, dy);
        for (let i = 0; i < pieces; i++) { own.x += dx / length * distance / pieces; own.y += dy / length * distance / pieces; collide(own); collide(own); }
      }
      own.stage = stageAt(own.y, finalStage);
      const state = knowledge(own.stage, slot), index = roomAt(own.x, own.y, own.stage);
      if (index !== -1) state.visited[index] = 1;
      const localY = own.y - stageOffset(own.stage), open = new Set(mapFor(plan, own.stage, slot).openDoors);
      GAPS.forEach((gap, id) => {
        if (Math.hypot(own.x - Math.max(gap.x, Math.min(own.x, gap.x + gap.w)), localY - Math.max(gap.y, Math.min(localY, gap.y + gap.h))) < PR + 2) state.doors[id] = open.has(id) ? 1 : 2;
      });
      if (now - lastSent >= 50) { socket.emit("elimination:move", { roundId: game.roundId, x: own.x, y: own.y }); lastSent = now; }
    }
    const viewer = game.players[watched] || own;
    const remaining = snapshot.players.filter(p => !p.eliminated).length;
    $("#eliminationStatus").textContent = game.done ? "淘汰競速結束" : own.eliminated ? `已淘汰 · 第 ${own.rank} 名 · 觀戰中` : own.finished ? "已抵達決賽王冠 · 等待前段淘汰結算" : own.stage === finalStage ? "最終 5×5 對決 · 先到 E3 獲勝" : `第 ${own.stage + 1} 段 · 各自競速，淘汰最後一人`;
    $("#eliminationCount").textContent = `${remaining} / ${game.players.filter(Boolean).length} 人仍在賽道`;
    $("#eliminationProgress").textContent = snapshot.stages.map((stage, i) => stage.final ? "決賽：共用迷宮" : `第 ${i + 1} 段：${Math.min(stage.arrived.length, stage.quota)} / ${stage.quota} 晉級`).join("　→　");
    for (const player of game.players.filter(Boolean)) {
      $(`#p${player.slot + 1}Steps`).textContent = `${player.steps} 步`;
      $(`#p${player.slot + 1}Score`).textContent = player.rank ? `第 ${player.rank} 名` : player.stage === finalStage ? "決賽" : `第 ${player.stage + 1} 段`;
      $(`#p${player.slot + 1}Score`).dataset.unit = "";
      $(`#scorePlayer${player.slot}`).dataset.eliminated = String(player.eliminated);
    }
    if (!game.done && now >= game.started) $("#gamePhase").textContent = own.eliminated ? "觀戰中" : own.finished ? "等待賽段結算" : "無縫淘汰競速";
    $(".dpad").hidden = own.eliminated || own.finished || game.done;
    if (!draw) return;
    const size = game.settings.viewMode === "scroll" ? 420 : BOARD + 80, half = size / 2;
    const target = { x: size > BOARD ? BOARD / 2 : Math.max(half, Math.min(BOARD - half, viewer.x)), y: viewer.y - size * .12 };
    const blend = reducedMotion ? 1 : 1 - Math.exp(-12 * dt);
    if (!camera) camera = target;
    else camera = { x: camera.x + (target.x - camera.x) * blend, y: camera.y + (target.y - camera.y) * blend };
    ctx.save(); ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#050b0d"; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(canvas.width / size, canvas.height / size); ctx.translate(half - camera.x, half - camera.y);
    const left = (BOARD - DOOR) / 2;
    plan.forEach((level, stage) => {
      const offset = stageOffset(stage);
      if (offset > camera.y + half || offset + BOARD < camera.y - half - CONNECTOR) return;
      const map = mapFor(plan, stage, watched), state = knowledge(stage, watched), open = new Set(map.openDoors);
      const doors = game.showRoutes ? Int8Array.from(GAPS, (_, id) => open.has(id) ? 1 : 2) : state.doors;
      const buffer = tiles[stage];
      paintBoard(buffer.ctx, BOARD, { doors, rooms: roomStates(doors, state.visited), visited: state.visited, players: [], paths: game.showRoutes ? allPaths(open) : null, flash: new Map(), startI: START_I, goalI: GOAL_I });
      buffer.ctx.fillStyle = "#203c34";
      if (stage > 0) buffer.ctx.fillRect(left, BOARD - WALL, DOOR, WALL);
      if (stage < finalStage && stage <= viewer.qualified) buffer.ctx.fillRect(left, 0, DOOR, WALL);
      ctx.drawImage(buffer.tile, 0, offset);
      if (stage < finalStage) {
        ctx.fillStyle = "#203c34"; ctx.fillRect(left, offset - CONNECTOR, DOOR, CONNECTOR);
        ctx.strokeStyle = "#65d5ba"; ctx.lineWidth = 2;
        ctx.strokeRect(left, offset - CONNECTOR, DOOR, CONNECTOR);
        ctx.fillStyle = "#e9ba77"; ctx.textAlign = "center"; ctx.font = "22px sans-serif";
        ctx.fillText("↑", BOARD / 2, offset - CONNECTOR / 2);
      }
      ctx.fillStyle = "#e9ba77"; ctx.textAlign = "left"; ctx.font = "14px sans-serif";
      ctx.fillText(level.final ? "FINAL · 共用 5×5" : `STAGE ${stage + 1} · ${watched + 1}P 個人路線`, 28, offset + 16);
    });
    // Draw in world space, not inside clipped board tiles: the whole player
    // remains visible while crossing either end of a connecting corridor.
    for (const player of game.players.filter(p => p && (p.slot === watched || (p.stage === finalStage && (!p.eliminated || game.done))))) {
      ctx.beginPath(); ctx.arc(player.x, player.y, PR + 2, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_STYLES[player.slot].color; ctx.fill(); ctx.strokeStyle = "#fff"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.font = "bold 11px sans-serif"; ctx.fillText(String(player.slot + 1), player.x, player.y + 4);
    }
    ctx.restore();
    canvas.dataset.view = "elimination";
    $("#scrollBadge").hidden = false;
    $("#boardHint").textContent = `${own.eliminated || game.done ? `觀戰 ${watched + 1}P · ` : ""}${viewer.stage === finalStage ? "決賽共用迷宮 · E3 王冠決勝" : `第 ${viewer.stage + 1} 段個人迷宮 · E3 向上銜接下一段`}`;
  }
  return {
    update, frame,
    finish() { update(snapshot); },
    correct(data) { Object.assign(game.players[slot], data); clearControls(true); },
  };
}
