// Shared storage: SigV4 signing, the S3 client against a tiny fake bucket server, and folder syncing.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { signV4, s3Store, withSync, localFiles, snapshot, diff, createStorage } = require("../lib/objstore");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "objstore-"));
const write = (root, rel, s) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), s); };

test("SigV4 matches AWS's published GET Object example", () => {
  const h = signV4({
    method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", headers: { Range: "bytes=0-9" },
    accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1", date: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
});

test("no bucket configured: local mode, nothing is copied", async () => {
  const s = createStorage({}, { root: tmp() });
  assert.equal(s.kind, "local");
  assert.equal(s.shared, true);
  assert.deepEqual(await s.pushMissing(["work/"]), []);
  assert.deepEqual(await s.pullMissing(["work/"]), []);
  const r2 = createStorage({ S3_BUCKET: "b", R2_ACCOUNT_ID: "acc", S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" }, { root: tmp() });
  assert.equal(r2.kind, "s3");
});

test("localFiles: folders recurse, plain names match files by prefix, half-written files are skipped", () => {
  const root = tmp();
  write(root, "work/shorts/a/meta.json", "{}");
  write(root, "work/shorts/a/sub/x.png", "x");
  write(root, "work/shorts/a/src.upload.part", "half");
  write(root, "work/shorts/ab/other.json", "{}");
  write(root, "work/shorts/music/m1.mp3", "m");
  write(root, "work/shorts/music/m2.mp3", "m");
  assert.deepEqual(localFiles(root, "work/shorts/a/").sort(), ["work/shorts/a/meta.json", "work/shorts/a/sub/x.png"]);
  assert.deepEqual(localFiles(root, "work/shorts/music/m1"), ["work/shorts/music/m1.mp3"]);
  assert.deepEqual(localFiles(root, "work/shorts/a/meta.json"), ["work/shorts/a/meta.json"]);
  assert.deepEqual(localFiles(root, "work/nothing/"), []);
});

test("snapshot + diff find new, changed and removed files", () => {
  const root = tmp();
  write(root, "d/keep.txt", "1");
  write(root, "d/change.txt", "1");
  write(root, "d/gone.txt", "1");
  const before = snapshot(root, ["d/"]);
  write(root, "d/change.txt", "22");
  write(root, "d/new.txt", "n");
  fs.rmSync(path.join(root, "d/gone.txt"));
  const d = diff(before, snapshot(root, ["d/"]));
  assert.deepEqual(d.changed.sort(), ["d/change.txt", "d/new.txt"]);
  assert.deepEqual(d.removed, ["d/gone.txt"]);
});

// a minimal S3: PUT / GET / DELETE objects and ListObjectsV2 (two keys per page, to exercise continuation)
function fakeS3() {
  const objects = new Map(), seen = [];
  const server = http.createServer(async (req, res) => {
    seen.push({ method: req.method, auth: req.headers.authorization || "" });
    const u = new URL(req.url, "http://x");
    const key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ""));
    if (req.method === "PUT") { const c = []; for await (const d of req) c.push(d); objects.set(key, Buffer.concat(c)); return res.end(); }
    if (req.method === "DELETE") { objects.delete(key); res.writeHead(204); return res.end(); }
    if (u.searchParams.get("list-type") === "2") {
      const all = [...objects.keys()].filter((k) => k.startsWith(u.searchParams.get("prefix") || "")).sort();
      const from = Number(u.searchParams.get("continuation-token") || 0), page = all.slice(from, from + 2), more = from + 2 < all.length;
      res.writeHead(200, { "content-type": "application/xml" });
      return res.end(`<ListBucketResult>${page.map((k) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><ETag>&quot;${require("crypto").createHash("md5").update(objects.get(k)).digest("hex")}&quot;</ETag><Size>${objects.get(k).length}</Size></Contents>`).join("")}<IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ""}</ListBucketResult>`);
    }
    if (!objects.has(key)) { res.writeHead(404); return res.end("<Error><Message>NoSuchKey</Message></Error>"); }
    res.end(objects.get(key));
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, objects, seen, endpoint: `http://127.0.0.1:${server.address().port}` })));
}

test("S3 client + sync: web pushes inputs, worker pulls them, worker pushes outputs, web pulls them", async () => {
  const s3 = await fakeS3();
  try {
    const raw = s3Store({ bucket: "bucket", endpoint: s3.endpoint, accessKeyId: "k", secretAccessKey: "s", prefix: "vs" });
    const web = withSync(raw, tmp()), worker = withSync(raw, tmp());
    write(web.root, "work/shorts/a/src.upload", Buffer.alloc(70000, 7));
    write(web.root, "work/shorts/a/opts.json", "{}");
    write(web.root, "work/shorts/a/name & more.json", "{}");
    write(web.root, "work/shorts/music/m1.mp3", "music");

    const sent = await web.pushMissing(["work/shorts/a/", "work/shorts/music/m1"]);
    assert.equal(sent.length, 4);
    assert.ok(s3.objects.has("vs/work/shorts/a/src.upload"), "keys carry the prefix");
    assert.ok(s3.seen.every((r) => r.auth.startsWith("AWS4-HMAC-SHA256 Credential=k/")), "every request is signed");
    assert.deepEqual(await web.pushMissing(["work/shorts/a/"]), [], "nothing new to send");
    write(web.root, "work/shorts/a/opts.json", "[]"); // same size, new content
    assert.deepEqual(await web.pushMissing(["work/shorts/a/"]), ["work/shorts/a/opts.json"], "an edit of the same length is still sent");

    const got = await worker.pullMissing(["work/shorts/a/", "work/shorts/music/m1"]);
    assert.equal(got.length, 4);
    assert.equal(fs.readFileSync(path.join(worker.root, "work/shorts/a/src.upload")).length, 70000);

    const before = worker.snapshot(["work/shorts/a/"]);
    write(worker.root, "work/shorts/a/short.mp4", "video");
    fs.rmSync(path.join(worker.root, "work/shorts/a/opts.json"));
    const { changed, removed } = diff(before, worker.snapshot(["work/shorts/a/"]));
    await worker.push(changed, removed);
    assert.ok(!s3.objects.has("vs/work/shorts/a/opts.json"), "removed on the bucket too");

    await web.pull(changed, removed);
    assert.equal(fs.readFileSync(path.join(web.root, "work/shorts/a/short.mp4"), "utf8"), "video");
    assert.ok(!fs.existsSync(path.join(web.root, "work/shorts/a/opts.json")));
    await assert.rejects(raw.get("missing", path.join(web.root, "x")), /404/);
  } finally { s3.server.close(); }
});
