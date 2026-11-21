// "Neon glitch" look, matching the app's HUD theme: faint scanlines, a slight constant RGB fringe and vignette, and
// short bursts of horizontal tearing (bands of the picture jump sideways) with a strong RGB split and static.
// Pure ffmpeg filters, no extra inputs. Bursts are spread through the video at irregular but repeatable times.

// small seeded random, so the same video always gets the same glitch timing
const rng = (seed) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

// filter chain from `inp` to `out` for a W x H video lasting `dur` seconds
function glitchFilter(inp, out, W, H, dur, seed = 7) {
  const r = rng(Math.round(seed * 1000) + 1);
  const bursts = [];
  for (let t = 0.12; t < dur - 0.3; t += 2.2 + r() * 2.6) bursts.push({ a: t, b: t + 0.08 + r() * 0.14 });
  const on = (list) => list.map((x) => `between(t,${x.a.toFixed(3)},${x.b.toFixed(3)})`).join("+") || "0";
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  // two tearing bands, each used in every other burst, at different heights and offsets
  const bands = [0, 1].map((k) => {
    const h = even(H * (0.06 + r() * 0.1)), y = even(H * (0.12 + r() * 0.66)), x = Math.round(W * (0.03 + r() * 0.05)) * (k ? -1 : 1);
    return { h, y, x, when: on(bursts.filter((_, i) => i % 2 === k || r() < 0.35)) };
  });
  const all = on(bursts), lines = Math.max(3, Math.round(H / 480)), grid = Math.max(2, Math.round(H / 640));
  return `${inp}rgbashift=rh=${grid}:bh=-${grid},split=3[gl0][gl1][gl2];` +
    bands.map((b, i) => `[gl${i + 1}]crop=iw:${b.h}:0:${b.y}[glb${i}]`).join(";") + ";" +
    `[gl0][glb0]overlay=x=${bands[0].x}:y=${bands[0].y}:enable='${bands[0].when}'[glo0];` +
    `[glo0][glb1]overlay=x=${bands[1].x}:y=${bands[1].y}:enable='${bands[1].when}',` +
    `rgbashift=rh=-${grid * 6}:bh=${grid * 6}:gv=${grid * 2}:enable='${all}',noise=alls=22:allf=t:enable='${all}',` +
    `eq=brightness=0.06:contrast=1.12:enable='${all}',` +
    `drawgrid=w=iw:h=${lines}:t=1:c=black@0.22,vignette=PI/5,format=yuv420p${out}`;
}

module.exports = { glitchFilter };
