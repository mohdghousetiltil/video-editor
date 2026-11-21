// App settings, saved on the server (DATA_DIR/data/settings.json) so every device sees the same ones.
const fs = require("fs");
const path = require("path");

// "provider" presets fill in the model choices; each choice can still be changed on its own.
const PRESETS = {
  default: {
    textModel: "nvidia/nemotron-3-super-120b-a12b",
    visionModel: "google/gemini-3.5-flash-lite",
    imageModel: "meta/muse-image",
  },
  muse: {
    textModel: "meta/muse-ember",
    visionModel: "meta/muse-spark-1.3",
    imageModel: "meta/muse-image",
  },
};
// what the Settings page offers (id, label); anything else is rejected
const CHOICES = {
  textModel: [
    ["nvidia/nemotron-3-super-120b-a12b", "Nemotron 3 Super (default)"],
    ["meta/muse-ember", "Muse Ember by Meta (cheapest)"],
    ["meta/muse-spark-1.3", "Muse Spark 1.3 by Meta (smartest)"],
    ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"],
  ],
  visionModel: [
    ["google/gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite (fast, cheapest)"],
    ["meta/muse-spark-1.3", "Muse Spark 1.3 by Meta (slower, ~3x cost)"],
    ["google/gemini-3.5-flash", "Gemini 3.5 Flash (sharper, ~5x cost)"],
  ],
  imageModel: [
    ["meta/muse-image", "Muse Image by Meta (~$0.01, keeps faces)"],
    ["google/gemini-3.1-flash-image", "Gemini 3.1 Flash Image"],
    ["bytedance-seed/seedream-5-0-lite", "Seedream 5.0 Lite"],
    ["black-forest-labs/flux-3-image-klein", "FLUX 3 Klein (~$0.01)"],
  ],
};
const DEFAULTS = {
  provider: "default",
  ...PRESETS.default,
  monthlyCap: 10, // USD a month; 0 = no cap (only when the user turns it off on purpose)
  capSet: false, // true once the user saved a cap themselves
  confirmUnder: 0, // skip the "this costs money" confirmation for calls estimated below this many dollars
  keepDays: 14, // caches, stitch folders, frames
  keepShortsDays: 60, // finished Shorts
  voice: "am_michael",
  eggs: true, // little easter-egg glitches in the UI
};

module.exports = function createSettings(DATA) {
  const FILE = path.join(DATA, "settings.json");
  let cache = null;
  const get = () => {
    if (!cache) {
      try { cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch { cache = { ...DEFAULTS }; }
      // older settings files saved "no cap" (0) as the default; give them the safe default unless a cap was chosen
      if (!cache.capSet && !(Number(cache.monthlyCap) > 0)) cache.monthlyCap = DEFAULTS.monthlyCap;
    }
    return cache;
  };
  // validate and merge a partial update from the Settings page
  const set = (patch) => {
    const next = { ...get() };
    if (patch.provider && PRESETS[patch.provider]) Object.assign(next, { provider: patch.provider }, PRESETS[patch.provider]);
    for (const k of Object.keys(CHOICES)) if (patch[k] && CHOICES[k].some(([id]) => id === patch[k])) next[k] = patch[k];
    if (patch.monthlyCap != null) { next.monthlyCap = Math.max(0, Math.min(10000, Number(patch.monthlyCap) || 0)); next.capSet = true; }
    if (patch.confirmUnder != null) next.confirmUnder = Math.max(0, Math.min(5, Number(patch.confirmUnder) || 0));
    if (patch.keepDays != null) next.keepDays = Math.max(1, Math.min(365, Math.round(Number(patch.keepDays) || DEFAULTS.keepDays)));
    if (patch.keepShortsDays != null) next.keepShortsDays = Math.max(1, Math.min(3650, Math.round(Number(patch.keepShortsDays) || DEFAULTS.keepShortsDays)));
    if (typeof patch.voice === "string" && /^[\w-]{2,40}$/.test(patch.voice)) next.voice = patch.voice;
    if (typeof patch.eggs === "boolean") next.eggs = patch.eggs;
    // a model picked by hand that differs from the preset makes it a custom mix
    const p = PRESETS[next.provider];
    if (p && Object.keys(p).some((k) => p[k] !== next[k])) next.provider = "custom";
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
    cache = next;
    return next;
  };
  return { get, set, CHOICES, PRESETS, DEFAULTS };
};
module.exports.PRESETS = PRESETS;
module.exports.CHOICES = CHOICES;
module.exports.DEFAULTS = DEFAULTS;
