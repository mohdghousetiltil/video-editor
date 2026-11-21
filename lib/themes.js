// Themes: one saved look (style, palette, lighting, camera, character, outfit, optional style picture) applied to
// every clip while Theme Lock is on, so scenes made on different days or models still look like one series.
// Built-in presets are read-only starting points; your own themes live in data/themes.json (+ data/themes/<id>.jpg).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PRESETS = [
  { id: "p-3dstory", name: "3D Story", emoji: "🧸", swatch: ["#f5b942", "#ff7a2f", "#111111", "#f4f4f4"],
    style: "3D animated feature-film style like Pixar, expressive characters with big eyes, soft subsurface skin, rich textures, smooth animation",
    palette: "warm gold, sunset orange, with black and white accents", lighting: "soft cinematic golden-hour light, gentle rim light", camera: "expressive close-ups and medium shots, slow push-ins, vertical 9:16",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "p-cinematic", name: "Cinematic Realistic", emoji: "🎥", swatch: ["#1d2b3a", "#c8a165", "#e8e1d4", "#0b0b0b"],
    style: "cinematic live-action film, realistic people, shallow depth of field, subtle film grain", palette: "teal shadows and warm amber highlights", lighting: "motivated dramatic lighting, soft contrast",
    camera: "smooth dolly and gimbal moves, 35mm lens look, vertical 9:16", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "minimal", music: "pad", look: "clean" },
  { id: "p-anime", name: "Anime", emoji: "🌸", swatch: ["#ff8fb1", "#7ec8ff", "#fff3b0", "#2b2d42"],
    style: "Japanese anime, hand-drawn cel shading, expressive eyes, detailed painted backgrounds", palette: "pastel pink, sky blue and soft yellow", lighting: "bright airy daylight with sparkles of light",
    camera: "dynamic angles, quick pans, vertical 9:16", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "bytedance/seedance-2.0-mini", res: "720p" }, voice: "af_bella", capStyle: "box", music: "pad", look: "clean" },
  { id: "p-kids", name: "Kids Cartoon", emoji: "🎈", swatch: ["#ffd23f", "#3bceac", "#ee4266", "#540d6e"],
    style: "bright 3D kids cartoon, cute round characters, glossy soft shading, simple friendly backgrounds", palette: "saturated primary colors: sunny yellow, mint, cherry red", lighting: "even cheerful daylight, no harsh shadows",
    camera: "steady wide and medium shots, gentle moves, vertical 9:16", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "bytedance/seedance-2.0-mini", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "p-neon", name: "Neon Glitch", emoji: "⚡", swatch: ["#00e5ff", "#ff2e93", "#8b5cff", "#05060d"],
    style: "cyberpunk night city, stylised realism, reflective wet surfaces", palette: "electric cyan, hot magenta and violet on deep black", lighting: "neon signs and strong rim light, haze",
    camera: "low angles, handheld energy, vertical 9:16", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "am_adam", capStyle: "box", music: "pad", look: "glitch" },
  { id: "p-ugc", name: "UGC Realistic", emoji: "📱", swatch: ["#f2e6d8", "#c9a27e", "#6b4f3a", "#ffffff"],
    style: "authentic smartphone selfie video, natural skin texture, no beauty filter, casual home setting", palette: "natural warm neutrals", lighting: "soft window daylight",
    camera: "handheld front camera at arm's length, vertical 9:16", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_bella", capStyle: "minimal", music: "none", look: "clean" },
].map((p) => ({ ...p, builtin: true }));

const QUALITY = "Quality: sharp focus, detailed natural textures, natural smooth motion, stable anatomy and faces, consistent clothing.";
const NEGATIVE = "warping, morphing faces, extra fingers, extra limbs, distorted or garbled text, flicker, blur, watermark";

const FIELDS = ["name", "emoji", "style", "palette", "lighting", "camera", "character", "outfit", "negative", "influencerId", "voice", "capStyle", "music", "look"];
const clean = (v, n = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function createThemes(DATA) {
  const FILE = path.join(DATA, "themes.json"), IMG = path.join(DATA, "themes");
  const read = () => { try { return JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { return []; } };
  const write = (a) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(a, null, 2)); };
  const imgPath = (id, kind = "style") => path.join(IMG, `${id}-${kind}.jpg`);
  const hasImg = (id, kind) => /^[\w-]+$/.test(id || "") && fs.existsSync(imgPath(id, kind));
  const pub = (t) => ({ ...t, styleImage: hasImg(t.id, "style") ? `/api/themes/${t.id}/image?v=${t.updated || 0}` : null, example: hasImg(t.id, "example") ? `/api/themes/${t.id}/example?v=${t.updated || 0}` : null });
  const all = () => [...PRESETS, ...read()];
  const get = (id) => all().find((t) => t.id === id) || null;
  // create or update one of your themes; editing a preset saves a copy ("3D Story (mine)")
  function save(b) {
    const list = read();
    let t = b.id && list.find((x) => x.id === b.id);
    if (!t) {
      const base = (b.id && PRESETS.find((p) => p.id === b.id)) || {};
      t = { ...base, builtin: false, id: "t" + crypto.randomBytes(5).toString("hex"), name: base.name ? base.name + " (mine)" : "My theme", from: base.id || null };
      list.push(t);
      if (base.id && hasImg(base.id, "example")) { try { fs.mkdirSync(IMG, { recursive: true }); fs.copyFileSync(imgPath(base.id, "example"), imgPath(t.id, "example")); } catch {} }
    }
    for (const k of FIELDS) if (b[k] !== undefined) t[k] = clean(b[k], k === "character" ? 1500 : 600);
    if (b.models && typeof b.models === "object") t.models = { cheap: clean(b.models.cheap, 80), good: clean(b.models.good, 80), res: ["480p", "720p", "1080p"].includes(b.models.res) ? b.models.res : "720p" };
    if (Array.isArray(b.swatch)) t.swatch = b.swatch.filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 5);
    t.updated = Date.now();
    write(list);
    return t;
  }
  function remove(id) { write(read().filter((t) => t.id !== id)); for (const k of ["style", "example"]) fs.rm(imgPath(id, k), { force: true }, () => {}); }
  function setImage(id, kind, dataUrl) {
    const m = String(dataUrl || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
    if (!m) throw Object.assign(new Error("Use a JPG, PNG or WEBP picture."), { status: 400 });
    fs.mkdirSync(IMG, { recursive: true });
    fs.writeFileSync(imgPath(id, kind), Buffer.from(m[2], "base64")); // stored as-is; browsers sniff the type
    const list = read(), t = list.find((x) => x.id === id);
    if (t) { t.updated = Date.now(); write(list); }
  }
  const styleDataUrl = (id) => (hasImg(id, "style") ? "data:image/jpeg;base64," + fs.readFileSync(imgPath(id, "style")).toString("base64") : null);
  return { all, get, save, remove, pub, setImage, imgPath, hasImg, styleDataUrl, PRESETS };
}

// the text added to every prompt while a theme is applied (character: the saved influencer's exact description wins)
function themeText(t, characterDesc) {
  if (!t) return "";
  const who = clean(characterDesc || t.character, 1500);
  const parts = [t.style && `Style: ${t.style}.`, t.palette && `Colour palette: ${t.palette}.`, t.lighting && `Lighting: ${t.lighting}.`, t.camera && `Camera: ${t.camera}.`,
    who && `Main character, exactly as described, same in every shot: ${who}.`, t.outfit && `Outfit, unchanged in every shot: ${t.outfit}.`].filter(Boolean);
  return parts.length ? ` Series look, keep identical in every shot. ${parts.join(" ")}` : "";
}
// quality booster + things to avoid, written into the prompt (works on every model)
function qualityText({ booster = true, negative = "", theme = null } = {}) {
  const avoid = [booster ? NEGATIVE : "", theme && theme.negative, clean(negative, 400)].filter(Boolean).join(", ");
  return (booster ? " " + QUALITY : "") + (avoid ? ` Avoid: ${avoid}.` : "");
}

module.exports = { createThemes, themeText, qualityText, PRESETS, QUALITY, NEGATIVE };
