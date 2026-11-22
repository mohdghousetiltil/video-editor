// A tiny semaphore: at most `n` jobs run at once, the rest wait their turn in order. Used to cap how many ffmpeg
// processes render at the same time, so two Shorts started together can't run a small server out of memory.
// timeoutMs: a job that runs longer gives its slot back (and fails), so one stuck job can't make every later one
// wait for a free render slot forever.
function createLimiter(n, { timeoutMs = 0, label = "This job" } = {}) {
  let active = 0;
  const waiting = [];
  const next = () => {
    if (active >= n || !waiting.length) return;
    active++;
    const { fn, resolve, reject } = waiting.shift();
    let done = false, timer = null;
    const finish = () => { if (done) return false; done = true; clearTimeout(timer); active--; next(); return true; };
    if (timeoutMs > 0) timer = setTimeout(() => { if (finish()) reject(new Error(`${label} took longer than ${Math.round(timeoutMs / 60000)} minutes and was stopped, so the next one can start. Try again.`)); }, timeoutMs);
    Promise.resolve().then(fn).then((v) => { if (finish()) resolve(v); }, (e) => { if (finish()) reject(e); });
  };
  const limit = (fn) => new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); next(); });
  limit.stats = () => ({ active, waiting: waiting.length, slots: n });
  return limit;
}
module.exports = { createLimiter };
