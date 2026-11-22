// Looks: one simple choice (Real, Disney, Pixar, Anime, Brain rot, or none) plus an optional character
// description. The chosen look and character go into every clip on every page, so a series stays consistent.
// Labels name the familiar style; the prompt text describes it in plain words (video models refuse brand names).

const LOOKS = [
  { id: "real", name: "Real", icon: "camera", swatch: ["#1d2b3a", "#c8a165", "#e8e1d4"],
    style: "realistic live-action video, real people and places, natural skin texture, true-to-life colours, shallow depth of field",
    lighting: "natural motivated light, soft contrast", camera: "smooth handheld or gimbal moves, 35mm lens look",
    models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "minimal", music: "pad", look: "clean" },
  { id: "disney", name: "Disney", icon: "castle", swatch: ["#3a6ea5", "#f6d55c", "#ed553b"],
    style: "classic hand-drawn 2D animated fairy-tale feature film, clean expressive linework, painterly watercolour backgrounds, charming characters with big eyes, fluid squash-and-stretch animation",
    lighting: "warm storybook light, soft glow", camera: "gentle sweeping moves and expressive medium shots",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "pixar", name: "Pixar", icon: "box", swatch: ["#f5b942", "#ff7a2f", "#4aa3df"],
    style: "high-end 3D animated feature film, expressive stylised characters with big eyes, soft subsurface skin, rich detailed textures, smooth appealing animation",
    lighting: "soft cinematic golden light with gentle rim light", camera: "expressive close-ups and medium shots, slow push-ins",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "anime", name: "Anime", icon: "flower", swatch: ["#ff8fb1", "#7ec8ff", "#fff3b0"],
    style: "Japanese anime, hand-drawn cel shading, expressive eyes, detailed painted backgrounds, vivid colours",
    lighting: "bright airy light with soft bloom", camera: "dynamic angles and quick pans",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "bytedance/seedance-2.0-mini", res: "720p" }, voice: "af_bella", capStyle: "box", music: "pad", look: "clean" },
  { id: "brainrot", name: "Brain rot", icon: "laugh", swatch: ["#00e5ff", "#ff2e93", "#c6ff00"],
    style: "absurd surreal internet-meme video, glossy 3D render, weird funny hybrid creatures and objects with exaggerated faces, hyper-saturated colours, chaotic high-energy comedy",
    lighting: "bright punchy light, strong colour pops", camera: "fast zooms, whip pans and dramatic close-ups",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_adam", capStyle: "bold", music: "none", look: "glitch" },
].map((p) => ({ ...p, builtin: true }));

// ids from the old theme presets map to the closest look so saved settings keep working
const OLD = { "p-cinematic": "real", "p-ugc": "real", "p-3dstory": "pixar", "p-kids": "pixar", "p-anime": "anime", "p-neon": "brainrot" };

const QUALITY = "Quality: sharp focus, detailed natural textures, natural smooth motion, stable anatomy and faces, consistent clothing.";
const NEGATIVE = "warping, morphing faces, extra fingers, extra limbs, distorted or garbled text, flicker, blur, watermark";

const clean = (v, n = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function createThemes() {
  const all = () => LOOKS;
  const get = (id) => LOOKS.find((t) => t.id === (OLD[id] || id)) || null;
  return { all, get, LOOKS };
}

// the text added to every prompt: the look, then the character exactly as written
function themeText(t, characterDesc) {
  const who = clean(characterDesc, 1500);
  const parts = [t && t.style && `Style: ${t.style}.`, t && t.lighting && `Lighting: ${t.lighting}.`, t && t.camera && `Camera: ${t.camera}.`,
    who && `Main character, exactly as described, same in every shot: ${who}.`].filter(Boolean);
  return parts.length ? ` Keep this look identical in every shot. ${parts.join(" ")}` : "";
}
// quality booster + things to avoid, written into the prompt (works on every model)
function qualityText({ booster = true, negative = "" } = {}) {
  const avoid = [booster ? NEGATIVE : "", clean(negative, 400)].filter(Boolean).join(", ");
  return (booster ? " " + QUALITY : "") + (avoid ? ` Avoid: ${avoid}.` : "");
}

module.exports = { createThemes, themeText, qualityText, LOOKS, PRESETS: LOOKS, QUALITY, NEGATIVE };
