import { DOORS } from "./layouts.js";
const SCALE = 1.4;
const ROOM = 140, WALL = 20, DOOR = 100;       // 門口原為 84，加寬約 19%，保留兩側實牆
const BOARD = 5 * ROOM + 6 * WALL;          // 820
const PR = 10, SPEED = 300;                  // 玩家半徑、移動速度（單位/秒；原為 350，降低約 14%）
const START = { r: 4, c: 2 }, GOAL = { r: 0, c: 2 };
const START_I = START.r * 5 + START.c, GOAL_I = GOAL.r * 5 + GOAL.c;
const A3B3 = [3, 2, 4, 2];                   // 永遠是實牆，不是門

const pos = i => WALL + i * (ROOM + WALL);
const roomName = (r, c) => String.fromCharCode(69 - r) + (c + 1);
const roomCX = i => pos(i % 5) + ROOM / 2;
const roomCY = i => pos((i / 5) | 0) + ROOM / 2;

function bandRect(d) {
  const [r1, c1] = d;
  return d[0] === d[2]
    ? { x: pos(c1) + ROOM, y: pos(r1), w: WALL, h: ROOM }
    : { x: pos(c1), y: pos(r1) + ROOM, w: ROOM, h: WALL };
}
function gapRect(d) {
  const [r1, c1] = d;
  return d[0] === d[2]
    ? { x: pos(c1) + ROOM, y: pos(r1) + (ROOM - DOOR) / 2, w: WALL, h: DOOR }
    : { x: pos(c1) + (ROOM - DOOR) / 2, y: pos(r1) + ROOM, w: DOOR, h: WALL };
}
const BANDS = DOORS.map(bandRect);
const GAPS  = DOORS.map(gapRect);

/** 每間房周圍有哪些門位 */
const DOORS_OF_ROOM = Array.from({ length: 25 }, () => []);
DOORS.forEach(([r1, c1, r2, c2], i) => {
  DOORS_OF_ROOM[r1 * 5 + c1].push(i);
  DOORS_OF_ROOM[r2 * 5 + c2].push(i);
});

/**
 * 房間顏色 0=未知 1=進得去（綠）2=進不去（紅）。
 * 判定用的是真實可推論的資訊：有任一道已知真門通到 → 綠；
 * 周圍所有門都已確認是假的 → 紅（資料保證這種房間完全不在迷宮裡）。
 * A3、E3 在 125 種佈局中必定連通，所以永遠是綠的。
 */
function roomStates(doors, visited) {
  const st = new Int8Array(25);
  for (let i = 0; i < 25; i++) {
    let anyOpen = false, allClosed = true;
    for (const d of DOORS_OF_ROOM[i]) {
      if (doors[d] === 1) { anyOpen = true; break; }
      if (doors[d] !== 2) allClosed = false;
    }
    if (anyOpen || (visited && visited[i])) st[i] = 1;
    else if (allClosed) st[i] = 2;
  }
  st[START_I] = 1; st[GOAL_I] = 1;
  return st;
}

/** 關著的門 = 實牆；開著的門 = 牆上中央留一個 DOOR 寬的缺口。 */
function buildWalls(open) {
  const w = [
    { x: 0, y: 0, w: BOARD, h: WALL },
    { x: 0, y: BOARD - WALL, w: BOARD, h: WALL },
    { x: 0, y: 0, w: WALL, h: BOARD },
    { x: BOARD - WALL, y: 0, w: WALL, h: BOARD },
    bandRect(A3B3),
  ];
  for (let r = 0; r < 4; r++)          // 四房交角的柱子，否則會有破洞可穿
    for (let c = 0; c < 4; c++)
      w.push({ x: pos(c) + ROOM, y: pos(r) + ROOM, w: WALL, h: WALL });

  for (let i = 0; i < DOORS.length; i++) {
    const b = BANDS[i], g = GAPS[i];
    if (!open.has(i)) { w.push(b); continue; }
    if (DOORS[i][0] === DOORS[i][2]) {
      w.push({ x: b.x, y: b.y, w: b.w, h: g.y - b.y });
      w.push({ x: b.x, y: g.y + g.h, w: b.w, h: b.y + b.h - g.y - g.h });
    } else {
      w.push({ x: b.x, y: b.y, w: g.x - b.x, h: b.h });
      w.push({ x: g.x + g.w, y: b.y, w: b.x + b.w - g.x - g.w, h: b.h });
    }
  }
  return w;
}

/**
 * 列舉 A3 → E3 的所有簡單路徑，由短到長。
 * 這 125 種佈局的迷宮都剛好帶一個環，所以每局固定有 2 條路線。
 */
function allPaths(open) {
  const adj = Array.from({ length: 25 }, () => []);
  open.forEach(i => {
    const [r1, c1, r2, c2] = DOORS[i], a = r1 * 5 + c1, b = r2 * 5 + c2;
    adj[a].push(b); adj[b].push(a);
  });
  const out = [], seen = new Set([START_I]), path = [START_I];
  (function walk(v) {
    if (v === GOAL_I) { out.push(path.slice()); return; }
    for (const w of adj[v]) {
      if (seen.has(w)) continue;
      seen.add(w); path.push(w);
      walk(w);
      path.pop(); seen.delete(w);
    }
  })(START_I);
  return out.sort((a, b) => a.length - b.length);
}


export { SCALE, ROOM, WALL, DOOR, BOARD, PR, SPEED, START_I, GOAL_I, START, GOAL, pos, roomCX, roomCY, GAPS, allPaths, buildWalls, roomStates };
