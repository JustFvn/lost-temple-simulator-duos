// Capture the gesture on the whole pad, but hit-test each move against the
// actual buttons so a held finger can switch directions without lifting.
export function createDpad(pad, { canPress, onChange }) {
  const buttons = [...pad.querySelectorAll("[data-key]")], pointers = new Map();
  const keyAt = (x, y) => buttons.find(button => {
    const rect = button.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  })?.dataset.key ?? null;
  function publish() {
    const keys = new Set([...pointers.values()].filter(p => !p.blocked && p.key).map(p => p.key));
    for (const button of buttons) button.classList.toggle("pressed", keys.has(button.dataset.key));
    onChange(keys);
  }
  function update(event) {
    const pointer = pointers.get(event.pointerId);
    if (!pointer || pointer.blocked) return;
    pointer.key = canPress() ? keyAt(event.clientX, event.clientY) : null;
    publish();
  }
  pad.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !canPress()) return;
    event.preventDefault();
    pointers.set(event.pointerId, { key: null, blocked: false });
    pad.setPointerCapture(event.pointerId);
    update(event);
  });
  pad.addEventListener("pointermove", event => {
    if (!pointers.has(event.pointerId)) return;
    event.preventDefault(); update(event);
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) pad.addEventListener(type, event => {
    if (!pointers.delete(event.pointerId)) return;
    publish();
  });
  return {
    clear() {
      const ids = [...pointers.keys()]; pointers.clear(); publish();
      for (const id of ids) if (pad.hasPointerCapture(id)) pad.releasePointerCapture(id);
    },
    blockUntilRelease() {
      for (const pointer of pointers.values()) { pointer.key = null; pointer.blocked = true; }
      publish();
    },
  };
}
