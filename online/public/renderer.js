import { DOORS } from "./layouts.js";
import { SCALE, ROOM, WALL, BOARD, PR, START_I, GOAL_I, pos, GAPS } from "./geometry.js";
import { roomCX, roomCY } from "./geometry.js";
import { VIEW_SIZE } from "./vision.js";
import { PLAYER_STYLES, TEAM_STYLES } from "./players.js";
import { rotationView } from "./rotation.js";
const BOARD_THEME = {
  dark: {
    mortar:  "#39443C",
    dark:    "#10150F",
    darkEdge:"#1A211C",
    goRoom:  "#17452C", goEdge:  "#2E7248",
    noRoom:  "#5C2116", noEdge:  "#8A3420",
    hereRoom:"#1F6B3E", hereEdge:"#3FA860",
    slot:    "#1A211C",
    slotEdge:"#2C3830",
    jade:    "#4BE77A",
    clay:    "#DB3615",
    gold:    "#E3B565",
    goldDim: "#8A6C38",
    goldRgb: "227,181,101",
    playerFill: "#FFF6E6",
    pathHaloRgb:"8,12,10",
    startRing:  "rgba(139,153,146,.30)",
  },
  light: {
    mortar:  "#DCD5BE",
    dark:    "#F3ECD8",      // 格子（未知房間）：奶黃，調淡一點，別太黃
    darkEdge:"#DCD0AE",
    goRoom:  "#9FE6B8", goEdge:  "#3FA860",
    noRoom:  "#EFC7BE", noEdge:  "#DB3615",
    hereRoom:"#3FBE6C", hereEdge:"#237C46",
    slot:    "#FAF7EC",      // 門（未知）：米白
    slotEdge:"#E2D8BE",
    jade:    "#4BE77A",
    clay:    "#DB3615",
    gold:    "#A9782F",
    goldDim: "#7C5A26",
    goldRgb: "169,120,47",
    playerFill: "#1A1A1A",
    pathHaloRgb:"255,255,255",
    startRing:  "rgba(51,51,51,.35)",
  },
};
/** 跟 CSS 的三態邏輯一致：手動選擇優先，其次跟系統設定。 */
function effectiveTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit === "light" || explicit === "dark") return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
const C = { ...BOARD_THEME.dark };
let boardThemeName = "dark";
/** 每幀呼叫一次即可，便宜的字串比較，主題一變就同步換掉棋盤色票。 */
function syncBoardTheme() {
  const t = effectiveTheme();
  if (t === boardThemeName) return;
  boardThemeName = t;
  Object.assign(C, BOARD_THEME[t]);
}
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function roundRect(ctx, x, y, w, h, r) {
  const k = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + k, y);
  ctx.arcTo(x + w, y, x + w, y + h, k);
  ctx.arcTo(x + w, y + h, x, y + h, k);
  ctx.arcTo(x, y + h, x, y, k);
  ctx.arcTo(x, y, x + w, y, k);
  ctx.closePath();
}

/**
 * st = { doors:Int8Array(39) 0未知/1開/2假, ghost:Int8Array|null 半透明的答案,
 *        rooms:Int8Array(25) 0未知/1綠/2紅, visited:Uint8Array|null,
 *        players:[{x,y,color}]|null, paths:[][]|null, flash:Map }
 */
function paintBoard(ctx, px, st) {
  ctx.save();
  ctx.clearRect(0, 0, px, px);
  ctx.fillStyle = "#050b0d"; ctx.fillRect(0, 0, px, px);
  if (Number.isFinite(st.rotation)) {
    const { center, scale } = rotationView(st.camera, px, !st.fixedRotation);
    ctx.translate(px / 2, px / 2);
    ctx.scale(scale, scale);
    ctx.rotate(st.rotation);
    ctx.translate(-center.x, -center.y);
  } else if (st.camera) {
    ctx.scale(px / VIEW_SIZE, px / VIEW_SIZE);
    ctx.translate(VIEW_SIZE / 2 - st.camera.x, VIEW_SIZE / 2 - st.camera.y);
  } else ctx.scale(px / BOARD, px / BOARD);

  ctx.fillStyle = C.mortar;                       // 石造骨架
  ctx.fillRect(0, 0, BOARD, BOARD);

  for (let i = 0; i < 25; i++) {                  // 房間地面
    const x = pos(i % 5), y = pos((i / 5) | 0);
    const s = st.rooms[i], been = st.visited && st.visited[i];
    let fill = C.dark, edge = C.darkEdge;
    if (s === 1) { fill = been ? C.hereRoom : C.goRoom; edge = been ? C.hereEdge : C.goEdge; }
    else if (s === 2) { fill = C.noRoom; edge = C.noEdge; }
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, ROOM, ROOM);
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + .5, y + .5, ROOM - 1, ROOM - 1);
    if (st.camera) {
      ctx.font = "12px sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "top";
      ctx.fillStyle = "rgba(210,233,217,.4)";
      const label = String.fromCharCode(69 - ((i / 5) | 0)) + (i % 5 + 1);
      if (st.fixedRotation) {
        ctx.save(); ctx.translate(x + ROOM - 12, y + ROOM - 12); ctx.rotate(-st.rotation); ctx.fillText(label, 0, 0); ctx.restore();
      } else ctx.fillText(label, x + 12, y + 12);
    }
  }

  drawGoal(ctx, st.goalLocked, st.goalI ?? GOAL_I, st.fixedRotation ? -st.rotation : 0);

  for (let i = 0; i < DOORS.length; i++) {        // 門格
    const g = GAPS[i], state = st.doors[i], ghost = st.ghost ? st.ghost[i] : 0;
    ctx.fillStyle = C.slot;
    ctx.fillRect(g.x, g.y, g.w, g.h);
    const shown = state || ghost;
    if (!shown) {
      ctx.strokeStyle = C.slotEdge; ctx.lineWidth = 1;
      ctx.strokeRect(g.x + .5, g.y + .5, g.w - 1, g.h - 1);
      continue;
    }
    const flash = st.flash && st.flash.get(i);
    ctx.save();
    // 玩家親自撞過的門全不透明；透過「顯示答案」等方式預先看到的門調低透明度
    // 做出區隔，但仍要夠明顯——.38 太淡，看起來幾乎跟未知的門差不多。
    ctx.globalAlpha = state ? 1 : .68;
    ctx.fillStyle = shown === 1 ? C.jade : C.clay;
    if (flash > 0) { ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 18 * flash; }
    ctx.fillRect(g.x, g.y, g.w, g.h);
    ctx.restore();
  }

  if (st.coveredDoors) {
    // Display only the player's completed segments, never unexplored answers.
    const segments = [...st.coveredDoors].map(id => {
      const [r, c, rr, cc] = DOORS[id]; return [r * 5 + c, rr * 5 + cc];
    });
    drawPaths(ctx, segments, true);
  }
  if (st.paths) drawPaths(ctx, st.paths);
  if (st.players) st.players.forEach((p, i) => { if (p) drawPlayer(ctx, p, p.slot ?? i, st.fixedRotation ? -st.rotation : 0, st.teamMode); });
  else if (st.player) drawPlayer(ctx, st.player, 0, st.fixedRotation ? -st.rotation : 0);

  drawStartMark(ctx, st.startI ?? START_I);
  ctx.restore();
}

function drawGoal(ctx, locked = false, goalI = GOAL_I, markerAngle = 0) {
  const cx = roomCX(goalI), cy = roomCY(goalI);

  ctx.save();                                     // 王冠：三角齒 + 底座
  ctx.translate(cx, cy);
  ctx.rotate(markerAngle);
  ctx.scale(SCALE, SCALE);
  ctx.fillStyle = locked ? "#8B9992" : C.gold;
  ctx.beginPath();
  ctx.moveTo(-17, 8); ctx.lineTo(-17, -6); ctx.lineTo(-8, 2); ctx.lineTo(0, -10);
  ctx.lineTo(8, 2); ctx.lineTo(17, -6); ctx.lineTo(17, 8);
  ctx.closePath(); ctx.fill();
  ctx.fillRect(-17, 11, 34, 4);
  if (locked) {
    ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("未解鎖", 0, 30);
  }
  ctx.restore();
}

function drawStartMark(ctx, startI = START_I) {
  const cx = roomCX(startI), cy = roomCY(startI);
  ctx.strokeStyle = C.startRing;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 5]);
  ctx.beginPath(); ctx.arc(cx, cy, 30 * SCALE, 0, Math.PI * 2); ctx.stroke();
  ctx.setLineDash([]);
}

/**
 * 所有路線畫成同一張虛線網：先把每條路線拆成房間之間的線段並去重，
 * 重疊的路段只畫一次，兩條路線在分岔前後自然接成一條線。
 */
function drawPaths(ctx, paths, covered = false) {
  const seen = new Set(), segs = [];
  for (const p of paths)
    for (let k = 1; k < p.length; k++) {
      const a = p[k - 1], b = p[k], key = a < b ? a + "-" + b : b + "-" + a;
      if (seen.has(key)) continue;
      seen.add(key);
      segs.push([a, b]);
    }
  ctx.save();
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  for (const [a, b] of segs) {
    ctx.moveTo(roomCX(a), roomCY(a));
    ctx.lineTo(roomCX(b), roomCY(b));
  }
  ctx.lineWidth = 7 * SCALE;                      // 純色襯底，讓虛線在彩色房間上也看得清，跟著主題變淺/變深
  ctx.strokeStyle = `rgba(${C.pathHaloRgb},.5)`;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.lineWidth = 3.5 * SCALE;
  ctx.strokeStyle = covered ? "#9AE6CE" : C.gold;
  ctx.setLineDash(covered ? [] : [11 * SCALE, 8 * SCALE]);
  ctx.stroke();
  ctx.restore();
}

function drawPlayer(ctx, p, index, markerAngle = 0, teamMode = false) {
  const color = PLAYER_STYLES[index].color;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,.45)"; ctx.shadowBlur = 5;
  if (teamMode) {
    ctx.beginPath(); ctx.arc(p.x, p.y, PR + 6, 0, Math.PI * 2);
    ctx.strokeStyle = TEAM_STYLES[p.team].color; ctx.lineWidth = 3; ctx.stroke();
  }
  ctx.beginPath(); ctx.arc(p.x, p.y, PR + 2, 0, Math.PI * 2);
  ctx.fillStyle = color; ctx.fill();
  ctx.strokeStyle = "#FFFFFF"; ctx.lineWidth = 2; ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = "#FFFFFF";
  ctx.font = "bold 11px " + getComputedStyle(document.documentElement).getPropertyValue("--display");
  ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.translate(p.x, p.y); ctx.rotate(markerAngle);
  ctx.fillText(String(index + 1), 0, .5);
  ctx.restore();
}
export { paintBoard, syncBoardTheme };
