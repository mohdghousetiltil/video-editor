// A tiny semaphore: at most `n` jobs run at once, the rest wait their turn in order. Used to cap how many ffmpeg
// processes render at the same time, so two Shorts started together can't run a small server out of memory.
function createLimiter(n) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  const limit = (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
  limit.stats = () => ({ active, waiting: waiting.length, slots: n });
  return limit;
}
module.exports = { createLimiter };
