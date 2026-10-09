import { BOARD } from "./geometry.js";

export const MAX_PLAYERS = 4;
export const PLAYER_STYLES = [
  { name: "藍色", className: "blue", color: "#35A7FF" },
  { name: "粉色", className: "pink", color: "#FF4F81" },
  { name: "金色", className: "amber", color: "#FFD166" },
  { name: "紫色", className: "violet", color: "#B78AFF" },
];
export const emptyScores = () => Array(MAX_PLAYERS).fill(0);
export function spawnPosition(slot, reverse = false) {
  const position = { x: 392 + (slot % 2) * 36, y: 730 + Math.floor(slot / 2) * 36 };
  // Mirror the whole formation: after the fixed 180° view transform every
  // player's screen position is the same as in an ordinary round.
  return reverse ? { x: BOARD - position.x, y: BOARD - position.y } : position;
}
export function availableSlot(players) {
  const occupied = new Set([...players].map(player => player.slot));
  return Array.from({ length: MAX_PLAYERS }, (_, slot) => slot).find(slot => !occupied.has(slot)) ?? -1;
}
