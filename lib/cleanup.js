// Deletes old working files so the volume doesn't fill up: cached clips, stitch folders, grabbed frames, shared
// motion clips and (much later) finished Shorts. Runs at start-up and then every 6 hours.
const fs = require("fs");
const path = require("path");

const DAY = 86400000;
const age = (f) => { try { return Date.now() - fs.statSync(f).mtimeMs; } catch { return 0; } };

// remove entries of `dir` matching `test` that are older than `days`; returns how many went
function sweep(dir, days, test = () => true) {
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const name of fs.readdirSync(dir)) {
    const f = path.join(dir, name);
    if (!test(name, f) || age(f) < days * DAY) continue;
    try { fs.rmSync(f, { recursive: true, force: true }); n++; } catch {}
  }
  return n;
}

function cleanup(STORE, { keepDays = 14, keepShortsDays = 60 } = {}, isBusy = () => false) {
  const W = path.join(STORE, "work");
  let n = 0;
  n += sweep(path.join(W, "videos"), keepDays, (x) => /\.mp4$|\.jpg$/.test(x));
  n += sweep(path.join(W, "frames"), 2);
  n += sweep(path.join(W, "share"), Math.min(7, keepDays));
  n += sweep(path.join(W, "cast"), keepDays * 2);
  n += sweep(path.join(W, "stills"), keepDays * 2); // storyboard pictures
  n += sweep(path.join(W, "enhanced"), keepDays); // enhanced copies
  // story stitch folders: work/<12 hex>/ (skip any still being written)
  n += sweep(W, keepDays, (x, f) => /^[a-f0-9]{12}$/.test(x) && fs.statSync(f).isDirectory() && !isBusy(x));
  n += sweep(path.join(W, "shorts"), keepShortsDays, (x) => /^\w+$/.test(x) && !isBusy(x));
  return n;
}

function startCleanup(STORE, getOpts, isBusy) {
  const go = () => { try { const n = cleanup(STORE, getOpts(), isBusy); if (n) console.log(`cleanup: removed ${n} old item(s)`); } catch (e) { console.error("cleanup failed:", e.message); } };
  setTimeout(go, 30000).unref();
  setInterval(go, 6 * 3600000).unref();
}

module.exports = { cleanup, startCleanup, sweep };
