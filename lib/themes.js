// Looks: one simple choice (Real, Disney, Pixar, Anime, Brain rot, or none) plus an optional character
// description. The chosen look and character go into every clip on every page, so a series stays consistent.
// Labels name the familiar style; the prompt text describes it in plain words (video models refuse brand names).

const LOOKS = [
  { id: "real", name: "Real", icon: "camera", swatch: ["#1d2b3a", "#c8a165", "#e8e1d4"],
    style: "realistic live-action video, real people and places, natural skin texture, true-to-life colours, shallow depth of field",
    lighting: "natural motivated light, soft contrast", camera: "steady locked-off camera at one fixed angle, 35mm lens look",
    models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "minimal", music: "pad", look: "clean" },
  { id: "disney", name: "Disney", icon: "castle", swatch: ["#3a6ea5", "#f6d55c", "#ed553b"],
    style: "classic hand-drawn 2D animated fairy-tale feature film, clean expressive linework, painterly watercolour backgrounds, charming expressive characters, fluid squash-and-stretch animation",
    lighting: "warm storybook light, soft glow", camera: "steady locked-off camera at one fixed angle, medium shot",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "pixar", name: "Pixar", icon: "box", swatch: ["#f5b942", "#ff7a2f", "#4aa3df"],
    style: "high-end 3D animated feature film, expressive stylised characters, soft subsurface skin, rich detailed textures, smooth appealing animation",
    lighting: "soft cinematic golden light with gentle rim light", camera: "steady locked-off camera at one fixed angle, medium shot",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_heart", capStyle: "bold", music: "pad", look: "clean" },
  { id: "anime", name: "Anime", icon: "flower", swatch: ["#ff8fb1", "#7ec8ff", "#fff3b0"],
    style: "Japanese anime, hand-drawn cel shading, expressive eyes, detailed painted backgrounds, vivid colours",
    lighting: "bright airy light with soft bloom", camera: "steady locked-off camera at one fixed angle, medium shot",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "bytedance/seedance-2.0-mini", res: "720p" }, voice: "af_bella", capStyle: "box", music: "pad", look: "clean" },
  { id: "brainrot", name: "Brain rot", icon: "laugh", swatch: ["#00e5ff", "#ff2e93", "#c6ff00"],
    style: "Italian brain rot internet-meme animation: glossy 3D render, every character is an absurd funny character made of a fruit, an animal or a bird (or a mix of them) with a big, very expressive face, eyes and mouth that show strong emotion, hyper-saturated colours, chaotic high-energy comedy",
    lighting: "bright punchy light, strong colour pops", camera: "steady locked-off camera at one fixed angle, punchy close framing",
    models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_adam", capStyle: "bold", music: "none", look: "glitch" },
  // ---- looks learned from a study of ~130 community video-generation prompts (prompts.chat): what the best ones have in common is a
  // fixed visual identity (style + light + camera), restrained effects, motivated light, hard cuts, and a short "avoid" list that
  // blocks the usual AI failures (morphing, duplicated people, plastic skin, random text). Each look below writes that down once. ----
  { id: "gametrailer", name: "Game", icon: "zap", swatch: ["#0b1f3a", "#4da3ff", "#ffb347"],
    style: "AAA fantasy-game launch trailer, pre-rendered CG, stylized semi-realistic characters with idealized faces, large luminous eyes, subsurface skin glow, individually simulated hair strands, real fabric weave, big particle and energy effects, volumetric god rays and floating dust, bloom, anamorphic lens, fast but readable action",
    lighting: "low golden-hour backlight with sun flare or a cold storm key with lightning accents, deep contrast", camera: "steady locked-off camera at one fixed angle, wide heroic framing, a clear subject in every shot",
    avoid: "collectible-figurine look, plastic skin, game HUD, on-screen text, 2D anime", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "bold", music: "epic", look: "clean" },
  { id: "horror", name: "Horror", icon: "surprised", swatch: ["#0a0f14", "#7e8a96", "#c1272d"],
    style: "cinematic supernatural horror, claustrophobic realism, psychological dread that builds slowly, realistic faces and frightened performances, restrained effects, the fear comes from anticipation, sound and scale rather than gore",
    lighting: "cold desaturated light, flickering fluorescent or a single practical lamp, deep oppressive shadows", camera: "steady locked-off camera at one fixed angle, wide while things feel normal, a tighter frame on faces when fear arrives",
    avoid: "gore, blood, cartoon monster, comedy, early monster reveal, bright cheerful colours, jump-cut morphing", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_onyx", capStyle: "minimal", music: "suspense", look: "clean" },
  { id: "fantasy", name: "Fantasy", icon: "leaf", swatch: ["#2a1b4d", "#ff9e7a", "#7ad7ff"],
    style: "photorealistic fantasy film, gentle magical creatures and wonder, soft haze, glowing details, lived-in costumes, realistic motion and weight",
    lighting: "dusk with a pink and orange sky reflected on water, soft magical glow, gentle mist, early stars", camera: "steady locked-off camera at one fixed angle, calm cinematic framing, shallow depth of field",
    avoid: "cartoon look, over-saturated neon, plastic skin, extra limbs, text", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "af_heart", capStyle: "minimal", music: "epic", look: "clean" },
  { id: "retro35", name: "Retro 35", icon: "film", swatch: ["#3b2a1d", "#d9a066", "#7a8f6a"],
    style: "a forgotten 1980s feature film shot on 35mm: visible film grain, soft halation, slightly faded colour, practical effects and miniatures, matte-painted backdrops, hand-built sets, slightly uneven vintage lens",
    lighting: "hard practical light, warm tungsten against cool shadows, smoke and haze", camera: "steady locked-off camera at one fixed angle, classic 1980s framing, medium shot",
    avoid: "digital sharpness, CGI sheen, modern colour grading, lens flares overdone, text", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_adam", capStyle: "bold", music: "cinematic", look: "clean" },
  { id: "painterly", name: "Painterly", icon: "flower", swatch: ["#ff9ecb", "#ffd166", "#5ec4b6"],
    style: "painterly stylized 3D animation, brush-textured surfaces, warm storybook colours, expressive wordless comedy acting, readable silhouettes, charming exaggerated timing",
    lighting: "soft warm key light with painted shadows", camera: "steady locked-off camera at one fixed angle, clear medium shot, every shot readable at a glance",
    avoid: "photoreal skin, dark horror mood, text, extra characters", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_bella", capStyle: "bold", music: "funny", look: "clean" },
  { id: "luxury", name: "Luxury", icon: "gem", swatch: ["#1b1b1f", "#e6d6a3", "#c9a14a"],
    style: "premium commercial: macro product detail, glossy reflections, slow elegant motion, immaculate set design, real material textures (leather, glass, metal, silk), calm confident pacing",
    lighting: "soft studio key with controlled highlights and a gold rim light, deep clean blacks", camera: "steady locked-off camera at one fixed angle, elegant beauty-shot framing with macro detail",
    avoid: "clutter, text and logos, wobbling product shape, distorted hands, busy background", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "bm_george", capStyle: "minimal", music: "chill", look: "clean" },
  { id: "docu", name: "Docu", icon: "video", swatch: ["#1c2a33", "#9ad0ff", "#d8c9a3"],
    style: "photoreal historical or nature documentary, natural light, true-to-life colour, observational camera, real locations and textures, calm authoritative feel",
    lighting: "natural golden-hour or overcast daylight, no stylised colour", camera: "steady locked-off camera at one fixed angle, wide establishing frame or a detail close-up",
    avoid: "fantasy elements, stylised colour grading, anachronisms, text overlays", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "bm_george", capStyle: "minimal", music: "cinematic", look: "clean" },
  { id: "securitycam", name: "Cam", icon: "target", swatch: ["#10190f", "#7fff7f", "#b9c7b0"],
    style: "found-footage and security-camera clip: fixed high angle, low-resolution digital look, slight fisheye, compression grain, flat realistic light, ordinary people doing something unexpected",
    lighting: "flat fluorescent or night-vision tone, no cinematic lighting", camera: "completely static camera at one fixed high angle, nothing in the frame moves but the people",
    avoid: "cinematic grading, camera movement, on-screen timestamps or text, stylised effects", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "am_michael", capStyle: "bold", music: "none", look: "clean" },
  { id: "estate", name: "Tour", icon: "wind", swatch: ["#0f2a2e", "#6fe3d1", "#f1e3c6"],
    style: "hyper-realistic architectural walkthrough for luxury real estate: true materials (stone, timber, glass), clean staging, no people or very few, crisp detail",
    lighting: "golden-hour sun through large windows, soft bounce light, glowing interior lamps", camera: "steady locked-off camera at one fixed angle, level horizon, wide architectural framing",
    avoid: "warped walls, melting furniture, clutter, text, fisheye distortion", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "minimal", music: "chill", look: "clean" },
  { id: "toon3d", name: "Toon 3D", icon: "heart", swatch: ["#ff9ad5", "#ffe066", "#66d9ff"],
    style: "bright cheerful 3D cartoon for children: rounded friendly characters, big simple shapes, saturated candy colours, bouncy squash-and-stretch, a magical colourful world",
    lighting: "bright even daylight, soft shadows, sparkles", camera: "steady locked-off camera at one fixed angle, clear friendly medium shot",
    avoid: "scary or dark mood, realistic skin, text, tiny details", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "google/veo-3.1-lite", res: "720p" }, voice: "af_nicole", capStyle: "bold", music: "upbeat", look: "clean" },
  { id: "indie", name: "Indie", icon: "coffee", swatch: ["#2b2118", "#d9b38c", "#6f8ea6"],
    style: "quiet naturalistic indie drama: real faces and small gestures, lived-in rooms, restrained performances, silence and pauses carry the feeling",
    lighting: "available light, a practical lamp at night, soft window light, natural contrast", camera: "steady locked-off camera at one fixed angle, intimate medium close-up, shallow depth of field",
    avoid: "glamour lighting, over-acted emotion, fast cuts, text", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "af_heart", capStyle: "minimal", music: "chill", look: "clean" },
  { id: "action", name: "Action", icon: "flame", swatch: ["#2a0f0a", "#ff7a3d", "#3dc7ff"],
    style: "kinetic live-action fight and chase choreography, clear readable cause and effect, grounded physics, sweat, dust and impact, one hero and one opponent clearly told apart",
    lighting: "hard practical light, strong contrast, colour contrast between the two sides", camera: "steady locked-off camera at one fixed angle, wide enough to read the geography of the fight",
    avoid: "gore, confusing cuts, duplicated fighters, rubbery limbs, text", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_adam", capStyle: "bold", music: "epic", look: "clean" },
  { id: "inkpaint", name: "Ink", icon: "pen", swatch: ["#16122b", "#b3a8ff", "#ff6f91"],
    style: "graphic painted 2.5D animation, ink-wash and brush strokes, flat layered cut-out depth, bold colour accents on a muted ground, expressive hand-made transformations",
    lighting: "painted flat light with strong colour accents", camera: "steady locked-off camera at one fixed angle, flat layered composition",
    avoid: "photorealism, 3D plastic look, text", models: { cheap: "x-ai/grok-imagine-video-1.5-lite", good: "bytedance/seedance-2.0-mini", res: "720p" }, voice: "af_bella", capStyle: "minimal", music: "chill", look: "clean" },
  { id: "epicfilm", name: "Epic", icon: "clapper", swatch: ["#141414", "#f2f2f2", "#d4a84b"],
    style: "ultra-realistic cinematic motivational short film: an emotional human story told in a few strong images, honest faces, weather and landscape as feeling, scale and silence",
    lighting: "dramatic motivated light, golden hour or blue hour, soft rim light on faces", camera: "steady locked-off camera at one fixed angle, wide landscape frame or a close-up on a face",
    avoid: "stock-footage look, text, over-saturation, extra people", models: { cheap: "google/veo-3.1-lite", good: "google/veo-3.1-fast", res: "720p" }, voice: "am_michael", capStyle: "bold", music: "cinematic", look: "clean" },
].map((p) => ({ ...p, builtin: true }));

// ids from the old theme presets map to the closest look so saved settings keep working
const OLD = { "p-cinematic": "real", "p-ugc": "real", "p-3dstory": "pixar", "p-kids": "pixar", "p-anime": "anime", "p-neon": "brainrot" };

const QUALITY = "Quality: sharp focus, detailed natural textures, natural smooth motion, stable anatomy and faces, consistent clothing.";
// every look: faces and eyes belong to the characters only (generators otherwise sprout eyes on props)
const FACE_RULE = "Only the story's characters (whatever they are made of: people, fruit, animals, birds) have faces, eyes or mouths; every prop, furniture, plant, lamp and background object is plain, with no eyes, face or mouth.";
const NEGATIVE = "warping, morphing faces, extra fingers, extra limbs, distorted or garbled text, flicker, blur, watermark";

// added to every generated clip: the camera holds one angle, and only the characters move. Both give way when the
// prompt itself asks for a camera move or a moving background.
const MOTION_RULE = " Camera: locked-off on a tripod, one fixed angle for the whole clip; no cuts, no angle changes, no zooms, pans," +
  " push-ins or shake, unless the prompt above asks for a camera move. Motion: only the main and supporting characters" +
  " move; the background, scenery and objects stay still unless the prompt above says they move.";

// Picture craft, learned from ~60 community image-generation prompts (prompts.chat): what separates a good prompt is not length but
// specifics: the medium named first, a clear light direction, real material and skin detail, and an intent behind the framing.
const PHOTO_CRAFT = "Make it look photographed, not rendered: natural micro-detail (visible skin pores and small asymmetries, a few flyaway hairs, fabric weave, scuffs and wear), " +
  "one clear light direction with soft falloff, a sharp subject against a softly blurred background, the subject placed with intent (rule of thirds), true-to-life colour. " +
  "No plastic or waxy skin, no over-retouched look, no extra fingers, no text, logos or watermark.";
const STYLIZED_CRAFT = "Keep one consistent drawing language across every picture: the same line weight, colour rules and shading, clear readable silhouettes, hand-made surface texture (brush, paper or clay grain), " +
  "one clear light direction, the subject placed with intent. No photographic skin, no mixed styles, no extra fingers, no text, logos or watermark.";
const ANIMATED = /animat|anime|cartoon|illustrat|painterly|ink-wash|cel[ -]|glossy 3D|brush|storybook|2.5D|CG\b/i;
const imageCraft = (style) => " " + (ANIMATED.test(String(style || "")) ? STYLIZED_CRAFT : PHOTO_CRAFT);

const clean = (v, n = 600) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

function createThemes() {
  const all = () => LOOKS;
  const get = (id) => LOOKS.find((t) => t.id === (OLD[id] || id)) || null;
  return { all, get, LOOKS };
}

// the text added to every prompt: the look, then the character exactly as written
function themeText(t, characterDesc) {
  const who = clean(characterDesc, 1500);
  const parts = [t && t.style && `Style: ${t.style}.`, t && t.lighting && `Lighting: ${t.lighting}.`, t && t.camera && `Camera: ${t.camera}.`, t && t.avoid && `This look avoids: ${t.avoid}.`,
    who && `Main character, exactly as described, same in every shot: ${who}.`].filter(Boolean);
  return parts.length ? ` Keep this look identical in every shot. ${parts.join(" ")} ${FACE_RULE}` : "";
}
// quality booster + things to avoid, written into the prompt (works on every model)
function qualityText({ booster = true, negative = "" } = {}) {
  const avoid = [booster ? NEGATIVE : "", clean(negative, 400)].filter(Boolean).join(", ");
  return (booster ? " " + QUALITY : "") + (avoid ? ` Avoid: ${avoid}.` : "");
}

module.exports = { imageCraft, PHOTO_CRAFT, STYLIZED_CRAFT, FACE_RULE, createThemes, themeText, qualityText, LOOKS, PRESETS: LOOKS, QUALITY, NEGATIVE, MOTION_RULE };
