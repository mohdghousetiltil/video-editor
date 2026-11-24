// Who gets swapped: the rules in public/people.js and the crop / paste-back in routes/faceswap.js
const test = require("node:test");
const assert = require("node:assert");
const people = require("../public/people.js");
const { cropPixels, pasteFilter, hidePixels } = require("../routes/faceswap.js");

// a face at (x, y) of height h in a frame; gender with a sure-ness
const face = (x, y, h, gender = "female", gp = 0.9, score = 0.9) => ({ x, y, w: h * 0.56, h, gender, gp, score });
// n frames, each with the faces f(i) returns
const frames = (n, f) => Array.from({ length: n }, (_, i) => ({ t: i, faces: f(i) }));

test("people: the same face across frames is one person, two faces are two people", () => {
  const ps = people.track(frames(10, (i) => [face(0.45 + i * 0.002, 0.3, 0.12), face(0.05, 0.5, 0.2, "male")]));
  assert.strictEqual(ps.length, 2);
  assert.ok(ps.every((p) => p.dets.length === 10 && p.presence === 1));
});

test("people: one person is always the one swapped, whatever the gender", () => {
  const ps = people.track(frames(8, () => [face(0.4, 0.3, 0.15, "male")]));
  const c = people.choose(ps, "female");
  assert.strictEqual(c.pick, ps[0]);
  assert.strictEqual(c.ambiguous, false);
});

test("people: a face reported twice in a frame and a broken track are still one person", () => {
  const ps = people.track(frames(20, (i) => [face(0.4 + (i > 10 ? 0.05 : 0), 0.4, 0.12), ...(i === 10 ? [face(0.41, 0.39, 0.12, "female", 0.9, 0.5)] : [])]));
  assert.strictEqual(ps.length, 1);
  const split = people.track(frames(20, (i) => i === 9 ? [] : [face(i < 9 ? 0.3 : 0.36, 0.4, 0.12)]));
  assert.strictEqual(split.length, 1);
});

test("people: a person who fills the frame needs no cut, a smaller one is cut out even when alone", () => {
  const big = people.track(frames(6, () => [face(0.3, 0.1, 0.35)]));
  assert.strictEqual(people.cropBox(big[0], big, 720, 1280), null);
  const small = people.track(frames(6, () => [face(0.7, 0.1, 0.06)]));   // e.g. next to someone whose back is turned
  assert.ok(people.cropBox(small[0], small, 1280, 720));
});

test("people: a woman influencer replaces the main woman, a man the main man", () => {
  // a big man in the middle all the time, a smaller woman at the side all the time
  const ps = people.track(frames(10, () => [face(0.42, 0.25, 0.2, "male"), face(0.75, 0.3, 0.1, "female")]));
  assert.strictEqual(people.choose(ps, "female").pick.gender, "female");
  assert.strictEqual(people.choose(ps, "male").pick.gender, "male");
  // nobody of that gender: the main person overall
  const men = people.track(frames(10, () => [face(0.42, 0.25, 0.2, "male"), face(0.75, 0.3, 0.1, "male")]));
  const c = people.choose(men, "female");
  assert.strictEqual(c.pick, men[0]);
  assert.match(c.reason, /No woman/);
});

test("people: the main one is on screen longest and biggest; someone passing by never counts", () => {
  const ps = people.track(frames(12, (i) => [face(0.4, 0.3, 0.14), ...(i === 5 ? [face(0.8, 0.3, 0.25)] : [])]));
  const c = people.choose(ps, "female");
  assert.strictEqual(c.pick.presence, 1);
  assert.strictEqual(c.ambiguous, false);
});

test("people: two equally main people of the influencer's gender are flagged for the user", () => {
  const ps = people.track(frames(10, () => [face(0.2, 0.3, 0.15), face(0.65, 0.3, 0.15)]));
  assert.strictEqual(people.choose(ps, "female").ambiguous, true);
});

test("people: the cut-out covers the chosen person's head and body, stays in the frame, keeps a sensible shape", () => {
  const ps = people.track(frames(10, (i) => [face(0.45 + i * 0.01, 0.3, 0.08), face(0.0, 0.5, 0.3, "male")]));
  const pick = people.choose(ps, "female").pick, b = people.cropBox(pick, ps, 720, 1280);
  assert.ok(b);
  assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= 1.0005 && b.y + b.h <= 1.0005);
  const d = pick.dets;
  assert.ok(b.x <= Math.min(...d.map((x) => x.x)) && b.x + b.w >= Math.max(...d.map((x) => x.x + x.w))); // wherever they move
  assert.ok(b.y < 0.3 && b.y + b.h > 0.3 + 0.08 * 4);                                                      // above the head, down the body
  const ar = (b.w * 720) / (b.h * 1280);
  assert.ok(ar >= 9 / 16 - 0.01 && ar <= 16 / 9 + 0.01);
});

test("swap crop: box to even pixels inside the frame; nonsense is refused", () => {
  assert.deepStrictEqual(cropPixels({ x: 0.3, y: 0.15, w: 0.6, h: 0.55 }, 720, 1280), { x: 216, y: 192, w: 432, h: 704 });
  const edge = cropPixels({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, 721, 1279);
  assert.ok(edge.x + edge.w <= 721 && edge.y + edge.h <= 1279 && edge.w % 2 === 0 && edge.h % 2 === 0);
  assert.strictEqual(cropPixels({ x: 0.9, y: 0, w: 0.5, h: 0.5 }, 720, 1280), null);  // runs off the frame
  assert.strictEqual(cropPixels({ x: 0, y: 0, w: 0.05, h: 0.5 }, 720, 1280), null);   // too thin
  assert.strictEqual(cropPixels({ x: "a", y: 0, w: 0.5, h: 0.5 }, 720, 1280), null);
  assert.strictEqual(cropPixels(null, 720, 1280), null);
});

test("swap paste-back: soft edges only where the box is inside the frame", () => {
  const inside = pasteFilter({ x: 100, y: 100, w: 400, h: 600 }, 720, 1280);
  assert.match(inside, /overlay=100:100/);
  assert.match(inside, /drawbox=x=24:y=24:w=352:h=552/);
  const corner = pasteFilter({ x: 0, y: 0, w: 400, h: 600 }, 720, 1280);
  assert.match(corner, /drawbox=x=0:y=0:w=376:h=576/);   // left and top edges touch the frame: no feather there
});

test("people: someone facing away (a body, no face) is kept out; the chosen person never is", () => {
  // the chosen woman faces the camera in the middle; a turned-away person stands on the left, seen as a body only
  const fr = frames(10, (i) => [face(0.45, 0.35, 0.1)]).map((f, i) => ({ ...f, bodies: [
    { x: 0.3, y: 0.3, w: 0.4, h: 0.5, score: 0.9 },                 // the chosen woman's body
    { x: 0.0, y: 0.0, w: 0.32, h: 0.95, score: 0.2 },               // turned away: a weak score, but in every frame
    ...(i === 4 ? [{ x: 0.75, y: 0.6, w: 0.2, h: 0.3, score: 0.15 }] : []),   // a one-off false find
  ] }));
  const ps = people.track(fr), pick = people.choose(ps, "female").pick;
  const hide = people.hideBoxes(pick, ps, fr);
  // above the chosen woman's body: full width; beside it: only up to her body's edge (0.3); below it: full width again
  assert.ok(hide.length >= 2 && hide.every((h) => h.x === 0));
  const beside = hide.filter((h) => h.y >= 0.3 - 1e-9 && h.y + h.h <= 0.8 + 1e-9);
  assert.ok(beside.length === 1 && beside[0].w <= 0.3 + 1e-9);
  // it never reaches over the chosen face
  assert.ok(hide.every((h) => h.x + h.w <= 0.45 || h.x >= 0.45 + 0.056));
});

test("people: a box that overlaps the chosen person is cut back to the side away from them", () => {
  const fr = frames(8, () => [face(0.5, 0.3, 0.1), face(0.2, 0.3, 0.1, "male")]).map((f) => ({ ...f, bodies: [] }));
  const ps = people.track(fr), pick = people.choose(ps, "female").pick;
  const hide = people.hideBoxes(pick, ps, fr);
  assert.strictEqual(hide.length, 1);                          // the man, from his face
  assert.ok(hide[0].x + hide[0].w <= 0.5 - 0.02);              // stops short of her face
});

test("swap hide: boxes to pixels; the paste-back keeps the original where people were covered", () => {
  assert.deepStrictEqual(hidePixels([{ x: 0, y: 0, w: 0.3, h: 0.9 }, { x: 2, y: 0, w: 1, h: 1 }, "x"], 720, 1280), [{ x: 0, y: 0, w: 216, h: 1152 }]);
  assert.deepStrictEqual(hidePixels(null, 720, 1280), []);
  const f = pasteFilter({ x: 0, y: 100, w: 700, h: 1000 }, 720, 1280, 24, [{ x: 0, y: 0, w: 216, h: 1152 }]);
  assert.match(f, /color=white:t=fill,boxblur=21:2,drawbox=x=0:y=-100:w=216:h=1152:color=black:t=fill,gblur=sigma=2.5/);
});

// a W x H RGBA picture: grey background, optional caption line (white letters with a black outline) and a plain white box
function picture(W, H, { caption = null, whiteBox = null } = {}) {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set([120, 110, 100, 255], i * 4);
  const put = (x, y, c) => { if (x >= 0 && y >= 0 && x < W && y < H) px.set([...c, 255], (y * W + x) * 4); };
  if (caption) for (let L = 0; L < caption.letters; L++) {        // letters: 6 px white strokes inside 2 px black outlines
    const x0 = caption.x + L * 16;
    for (let y = caption.y - 2; y < caption.y + caption.h + 2; y++) for (let x = x0 - 2; x < x0 + 8; x++) put(x, y, [10, 10, 10]);
    for (let y = caption.y; y < caption.y + caption.h; y++) for (let x = x0; x < x0 + 6; x++) put(x, y, [250, 250, 250]);
  }
  if (whiteBox) for (let y = whiteBox.y; y < whiteBox.y + whiteBox.h; y++) for (let x = whiteBox.x; x < whiteBox.x + whiteBox.w; x++) put(x, y, x === whiteBox.x ? [10, 10, 10] : [250, 250, 250]);
  return px;
}

test("captions: a line of outlined letters is found; a plain white object is not", () => {
  const W = 320, H = 568;
  const found = people.textRects(picture(W, H, { caption: { x: 60, y: 400, h: 18, letters: 12 } }), W, H);
  assert.strictEqual(found.length, 1);
  assert.ok(found[0].y * H <= 400 && (found[0].y + found[0].h) * H >= 418);
  assert.ok(found[0].x * W <= 60 && (found[0].x + found[0].w) * W >= 60 + 11 * 16 + 6);
  assert.deepStrictEqual(people.textRects(picture(W, H, { whiteBox: { x: 100, y: 300, w: 80, h: 30 } }), W, H), []);
});

test("captions: the same line over several frames is one box; a one-frame find is dropped", () => {
  const fr = [{ text: [{ x: 0.2, y: 0.7, w: 0.4, h: 0.04 }] }, { text: [{ x: 0.15, y: 0.71, w: 0.6, h: 0.04 }] }, { text: [{ x: 0.3, y: 0.2, w: 0.3, h: 0.03 }] }];
  const boxes = people.captionBoxes(fr);
  assert.strictEqual(boxes.length, 1);
  assert.deepStrictEqual(boxes[0], { x: 0.15, y: 0.7, w: 0.6, h: 0.05 });
});

test("voice: the same influencer always gets the same voice and pitch, another influencer may differ", () => {
  const { pickVoice, pitchShift, seededRnd } = require("../routes/faceswap.js");
  const a1 = pickVoice("female", seededRnd("inf:abc")), a2 = pickVoice("female", seededRnd("inf:abc"));
  assert.strictEqual(a1, a2);
  assert.strictEqual(pitchShift(150, "female", seededRnd("inf:abc")), pitchShift(150, "female", seededRnd("inf:abc")));
  const many = new Set(Array.from({ length: 30 }, (_, i) => pickVoice("female", seededRnd("inf:" + i))));
  assert.ok(many.size > 3);
});

test("swap keyframe: the frame where the chosen person's eyes are open, not the first one", () => {
  const fr = frames(8, (i) => [{ ...face(0.4, 0.3, 0.12), eyes: i === 5 ? 0.32 : 0.12 }]);
  const ps = people.track(fr), k = people.keyFrame(ps[0], fr, 24);
  assert.strictEqual(k.t, 5);
  assert.strictEqual(k.frame, 5 * 24 + 1);
  const { ENGINES } = require("../routes/faceswap.js");
  assert.strictEqual(ENGINES.pixverse.input("v", "f", { keyframe: 37 }).keyframe_id, 37);
  assert.strictEqual(ENGINES.pixverse.input("v", "f").keyframe_id, 1);
});

test("swap cut-out size: short side 720, never over PixVerse's 1920 limit", () => {
  const { cutScale } = require("../routes/faceswap.js");
  assert.strictEqual(cutScale(432, 704), "scale=720:1174");
  assert.strictEqual(cutScale(284, 856), "scale=638:1920");     // the thin party cut-out that was refused
  assert.strictEqual(cutScale(1280, 720), "scale=1280:720");
});
