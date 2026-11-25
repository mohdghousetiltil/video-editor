// Shared file storage between the web service and render workers.
//   S3_BUCKET set   -> an S3-compatible bucket (Cloudflare R2, AWS S3, MinIO ...). Keys mirror paths under DATA_DIR,
//                      e.g. work/shorts/<id>/short.mp4, so a file has the same name on every machine.
//   S3_BUCKET unset -> "local": web and worker share one DATA_DIR (one machine, local dev), nothing is copied.
// No SDK: requests are signed with AWS Signature V4 using node's crypto and sent with fetch.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s).digest();
const EMPTY_HASH = sha256("");
// RFC 3986 encoding, as SigV4 wants it ("/" kept in paths)
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const encPath = (p) => p.split("/").map(enc).join("/");

// Authorization header for one request (AWS Signature Version 4)
function signV4({ method, url, headers, payloadHash = EMPTY_HASH, accessKeyId, secretAccessKey, region, service = "s3", date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const h = { ...Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host: u.host, "x-amz-date": amzDate, "x-amz-content-sha256": payloadHash };
  const names = Object.keys(h).sort();
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("&");
  const canonical = [method, encPath(decodeURIComponent(u.pathname)), query, names.map((n) => `${n}:${h[n]}\n`).join(""), names.join(";"), payloadHash].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac("AWS4" + secretAccessKey, day), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign).digest("hex");
  return { ...h, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}` };
}

function s3Store({ bucket, endpoint, region = "auto", accessKeyId, secretAccessKey, prefix = "" }) {
  const base = endpoint ? `${endpoint.replace(/\/$/, "")}/${bucket}` : `https://${bucket}.s3.${region}.amazonaws.com`;
  const pre = prefix ? prefix.replace(/\/?$/, "/") : "";
  const urlOf = (key, qs = "") => `${base}/${encPath(pre + key)}${qs}`;
  async function req(method, url, { headers = {}, body, payloadHash, ok = [200] } = {}) {
    const signed = signV4({ method, url, headers, payloadHash: payloadHash || (body ? "UNSIGNED-PAYLOAD" : EMPTY_HASH), accessKeyId, secretAccessKey, region });
    const r = await fetch(url, { method, headers: signed, body, ...(body && typeof body.pipe === "function" ? { duplex: "half" } : {}) });
    if (!ok.includes(r.status)) {
      const t = await r.text().catch(() => "");
      throw Object.assign(new Error(`storage ${method} ${r.status}: ${(t.match(/<Message>([^<]*)/) || [])[1] || t.slice(0, 200)}`), { status: r.status });
    }
    return r;
  }
  return {
    kind: "s3",
    shared: false,
    async put(key, file) {
      const size = fs.statSync(file).size;
      await req("PUT", urlOf(key), { headers: { "content-length": size }, body: size ? fs.createReadStream(file) : Buffer.alloc(0) });
    },
    async get(key, file) {
      const r = await req("GET", urlOf(key));
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.dl`;
      await pipeline(Readable.fromWeb(r.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, file);
    },
    async del(key) { await req("DELETE", urlOf(key), { ok: [200, 204, 404] }); },
    // every key under a prefix -> [{ key, size }]
    async list(p) {
      const out = [];
      let token = null;
      do {
        const qs = `?list-type=2&prefix=${enc(pre + p)}${token ? `&continuation-token=${enc(token)}` : ""}`;
        const xml = await (await req("GET", `${base}/${qs}`)).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const k = (m[1].match(/<Key>([^<]*)<\/Key>/) || [])[1], s = (m[1].match(/<Size>(\d+)<\/Size>/) || [])[1];
          const etag = unxml((m[1].match(/<ETag>([^<]*)<\/ETag>/) || [])[1] || "").replace(/"/g, "");
          if (k != null) out.push({ key: unxml(k).slice(pre.length), size: Number(s || 0), etag });
        }
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? unxml((xml.match(/<NextContinuationToken>([^<]*)/) || [])[1] || "") : null;
      } while (token);
      return out;
    },
  };
}
const unxml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

// ---------- syncing paths under DATA_DIR ----------
// A path ending in "/" is a folder (everything inside, recursively); anything else is one file, or every file in its
// folder whose name starts with it (e.g. "work/shorts/music/m123" matches m123.mp3).
const norm = (rel) => rel.replace(/\\/g, "/").replace(/^\/+/, "");
function localFiles(root, rel) {
  rel = norm(rel);
  const abs = path.join(root, rel);
  const out = [];
  const walk = (dir, r) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of names) {
      if (d.name.endsWith(".part") || d.name.endsWith(".dl") || d.name.endsWith(".tmp")) continue; // half-written
      if (d.isDirectory()) walk(path.join(dir, d.name), `${r}${d.name}/`);
      else if (d.isFile()) out.push(r + d.name);
    }
  };
  if (rel.endsWith("/")) walk(abs, rel);
  else {
    let st = null;
    try { st = fs.statSync(abs); } catch {}
    if (st && st.isFile()) out.push(rel);
    else if (st && st.isDirectory()) walk(abs, rel + "/");
    else {
      const dir = path.dirname(rel), b = path.basename(rel);
      try { for (const n of fs.readdirSync(path.join(root, dir))) if (n.startsWith(b) && fs.statSync(path.join(root, dir, n)).isFile()) out.push(`${dir}/${n}`); } catch {}
    }
  }
  return out;
}
// { rel: "size:mtime" } for every file under the given paths
function snapshot(root, rels) {
  const m = {};
  for (const r of rels) for (const f of localFiles(root, r)) { try { const s = fs.statSync(path.join(root, f)); m[f] = `${s.size}:${s.mtimeMs}`; } catch {} }
  return m;
}
const sizeOf = (root, rel) => { try { return fs.statSync(path.join(root, rel)).size; } catch { return -1; } };
// is the local file the same as the bucket's copy? Same size, and for files up to 64 MB the same MD5 (a plain
// upload's ETag), so a small file edited to the same length (settings, meta.json) still counts as changed.
const SMALL = 64 * 1048576;
function same(root, rel, obj) {
  if (!obj || sizeOf(root, rel) !== obj.size) return false;
  if (!obj.etag || !/^[a-f0-9]{32}$/.test(obj.etag) || obj.size > SMALL) return true;
  try { return crypto.createHash("md5").update(fs.readFileSync(path.join(root, rel))).digest("hex") === obj.etag; } catch { return false; }
}

// run fn over items, `n` at a time
async function eachLimit(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}

function createStorage(env = process.env, { root }) {
  const bucket = (env.S3_BUCKET || env.R2_BUCKET || "").trim();
  const store = bucket ? s3Store({
    bucket,
    endpoint: env.S3_ENDPOINT || (env.R2_ACCOUNT_ID ? `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : ""),
    region: env.S3_REGION || (env.S3_ENDPOINT || env.R2_ACCOUNT_ID ? "auto" : "us-east-1"),
    accessKeyId: env.S3_ACCESS_KEY_ID || env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || env.AWS_SECRET_ACCESS_KEY,
    prefix: env.S3_PREFIX || "",
  }) : { kind: "local", shared: true };
  return withSync(store, root);
}

// adds the folder-level copy operations to a raw store ({ put, get, del, list }) or to the local no-op store
function withSync(store, root) {
  const PAR = 4;
  const remotePrefix = (rel) => norm(rel);
  return {
    ...store,
    root,
    // upload local files under `rels` that the bucket doesn't have yet (or has with another size)
    async pushMissing(rels) {
      if (store.shared) return [];
      const sent = [];
      for (const rel of rels) {
        const remote = new Map((await store.list(remotePrefix(rel))).map((o) => [o.key, o]));
        const todo = localFiles(root, rel).filter((f) => !same(root, f, remote.get(f)));
        await eachLimit(todo, PAR, async (f) => { await store.put(f, path.join(root, f)); sent.push(f); });
      }
      return sent;
    },
    // download bucket files under `rels` that are missing here (or have another size)
    async pullMissing(rels) {
      if (store.shared) return [];
      const got = [];
      for (const rel of rels) {
        const todo = (await store.list(remotePrefix(rel))).filter((o) => !same(root, o.key, o));
        await eachLimit(todo, PAR, async (o) => { await store.get(o.key, path.join(root, o.key)); got.push(o.key); });
      }
      return got;
    },
    // exact files: upload changed ones, delete removed ones
    async push(changed = [], removed = []) {
      if (store.shared) return;
      await eachLimit(changed.filter((f) => sizeOf(root, f) >= 0), PAR, (f) => store.put(f, path.join(root, f)));
      await eachLimit(removed, PAR, (f) => store.del(f));
    },
    async pull(changed = [], removed = []) {
      if (store.shared) return;
      await eachLimit(changed, PAR, (f) => store.get(f, path.join(root, f)));
      for (const f of removed) fs.rmSync(path.join(root, f), { force: true });
    },
    snapshot: (rels) => snapshot(root, rels),
  };
}

// what changed between two snapshots
function diff(before, after) {
  const changed = Object.keys(after).filter((f) => before[f] !== after[f]);
  const removed = Object.keys(before).filter((f) => !(f in after));
  return { changed, removed };
}

module.exports = { createStorage, withSync, s3Store, signV4, localFiles, snapshot, diff };
