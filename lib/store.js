// A Map that is also kept in a JSON file, so in-progress video jobs survive a server restart or redeploy.
// Writes are batched (at most one per second).
const fs = require("fs");
const path = require("path");

function persistentMap(file, { max = 500 } = {}) {
  const m = new Map();
  try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(file, "utf8")))) m.set(k, v); } catch {}
  let t = null;
  const flush = () => {
    t = null;
    try {
      const entries = [...m.entries()].slice(-max);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + ".tmp", JSON.stringify(Object.fromEntries(entries)));
      fs.renameSync(file + ".tmp", file);
    } catch (e) { console.error("saving", path.basename(file), "failed:", e.message); }
  };
  const save = () => { if (!t) t = setTimeout(flush, 1000); };
  const set = m.set.bind(m), del = m.delete.bind(m);
  m.set = (k, v) => { set(k, v); save(); return m; };
  m.delete = (k) => { const r = del(k); save(); return r; };
  m.save = save; // call after changing a stored object in place
  m.flush = flush;
  return m;
}

module.exports = { persistentMap };
