// Pure helpers for the Shorts maker (no I/O), kept apart so they can be unit-tested.

// Times can come back as seconds (123.4) or as "HH:MM:SS(.mmm)" read off the burned-in clock.
const toSec = (v) => {
  if (typeof v === "number") return v;
  const p = String(v ?? "").trim().split(":").map(Number);
  if (!p.length || p.some((n) => !isFinite(n))) return NaN;
  return p.reduce((a, n) => a * 60 + n, 0);
};

// lo/hi: the part of the video the Short may come from (the whole video, or the creator's time range)
function cleanSegments(plan, lo, hi, min, max) {
  const total = hi;
  let segs = (Array.isArray(plan.segments) ? plan.segments : [])
    .map((s) => ({ start: Math.max(lo, toSec(s.start)), end: Math.min(hi, toSec(s.end)) }))
    .filter((s) => isFinite(s.start) && isFinite(s.end) && s.end - s.start >= 1.5)
    .sort((a, b) => a.start - b.start);
  const merged = [];
  for (const s of segs) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end + 0.3) last.end = Math.max(last.end, s.end); else merged.push({ ...s });
  }
  segs = merged.slice(0, 4);
  if (!segs.length) { // older-style answer or nothing usable: one piece from start/end
    const st = Math.max(lo, Math.min(toSec(plan.start) || lo, hi));
    segs = [{ start: st, end: Math.min(total, toSec(plan.end) || st + max) }];
  }
  const sum = () => segs.reduce((a, s) => a + s.end - s.start, 0);
  while (sum() > max + 0.01) { // too long: shorten from the end
    const last = segs[segs.length - 1], over = sum() - max;
    if (last.end - last.start - over >= 1.5) last.end -= over; else segs.pop();
  }
  if (sum() < min) { // too short: grow the last piece, then the first one backwards
    const last = segs[segs.length - 1];
    last.end = Math.min(total, last.end + (min - sum()));
    if (sum() < min) segs[0].start = Math.max(lo, segs[0].start - (min - sum()));
  }
  if (hi - lo <= min) segs = [{ start: lo, end: hi }];
  return segs.map((s) => ({ start: +s.start.toFixed(2), end: +s.end.toFixed(2) }));
}


// "1:02:03", "12:30", "95" or "" -> seconds or null
const parseTime = (v) => {
  const t = String(v ?? "").trim();
  if (!/^\d+(:\d{1,2}){0,2}(\.\d+)?$/.test(t)) return null;
  return t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);
};

module.exports = { toSec, cleanSegments, parseTime };
