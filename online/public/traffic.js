// A shared schedule uses the round's start time, not each browser's timers.
export const TRAFFIC_GRACE_MS = 250;
export function createTrafficSchedule(random = Math.random) {
  return Array.from({ length: 16 }, () => [
    { phase: "green", duration: 3000 + Math.floor(random() * 2001) },
    { phase: "yellow", duration: 800 },
    { phase: "red", duration: 2000 + Math.floor(random() * 1501) },
  ]).flat();
}
export function trafficState(schedule, elapsed) {
  const period = schedule.reduce((sum, item) => sum + item.duration, 0);
  const cycle = Math.floor(Math.max(0, elapsed) / period);
  let offset = Math.max(0, elapsed) % period;
  for (let i = 0; i < schedule.length; i++) {
    const item = schedule[i];
    if (offset < item.duration) return { phase: item.phase, remaining: item.duration - offset, phaseElapsed: offset, index: cycle * schedule.length + i };
    offset -= item.duration;
  }
}
