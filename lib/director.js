// The Director: the app's brain. Given what you want to make, it reads every available video model (quality,
// strengths, price, lengths, frames) and decides the model, length, resolution and process (picture first, connect
// scenes, Enhance) that give the best quality the budget allows. An LLM proposes the plan; this file checks it
// against the real catalog, recomputes every cost from the price table, fits it to the budget, and falls back to
// fixed rules when the LLM fails, so "Auto" always answers.

const PAGES = ["clip", "story", "ugc", "poses", "motion"];
const RES_ORDER = ["480p", "720p", "1080p"];
const round = (n, d = 4) => +Number(n).toFixed(d);

// $/s for a model at a resolution (with sound or silent)
function rate(m, res, audio) {
  const p = m.price[res] || m.price[m.res.includes("720p") ? "720p" : m.res[0]];
  return p ? p[audio && m.audio ? 0 : 1] : Infinity;
}
const snap = (m, d) => {
  const want = Math.max(1, Math.round(Number(d) || 0));
  return m.durs.length ? m.durs.reduce((b, n) => (Math.abs(n - want) < Math.abs(b - want) ? n : b), m.durs[0]) : want;
};
// best resolution a model has for this job: 720p for phones, 1080p only when asked for a hero/YouTube shot
function pickRes(m, want = "720p") {
  if (m.res.includes(want)) return want;
  return m.res.includes("720p") ? "720p" : m.res[0];
}

// models valid for this request
function candidates(catalog, req, available = () => true) {
  return Object.values(catalog).filter((m) => {
    if (m.hidden || m.bare || !m.res.length || !m.durs.length || !available(m)) return false;
    if (req.aspect && m.asp.length && !m.asp.includes(req.aspect)) return false;
    if (req.page === "motion" && !m.tags.includes("video-reference")) return false;
    if ((req.startPicture || req.page === "poses") && !(m.frames || []).includes("first_frame")) return false;
    if (req.audio === true && !m.audio) return false;
    return true;
  });
}

// what a request needs, read from its words (used by the rules, and given to the brain as hints)
function needs(text) {
  const t = String(text || "").toLowerCase();
  return {
    faces: /\b(face|faces|close-?up|portrait|woman|man|girl|boy|person|people|she|he|smil|talk|says?|selfie|influencer|character)\b/.test(t),
    dialogue: /["“]|\b(says|said|talks?|speaks?|dialog|interview|testimonial|review)\b/.test(t),
    cartoon: /\b(cartoon|pixar|disney|3d animat|2d animat|hand-drawn|kids|anime|animated|clay|toon|meme|brain rot)\b/.test(t),
    motion: /\b(run|runs|running|jump|dance|fight|chase|surf|ride|race|fly|flies|action|fast)\b/.test(t),
    closeup: /close-?up|portrait|\bher face\b|\bhis face\b|\beyes\b|selfie/.test(t),
  };
}

// fixed rules: the best quality per dollar that fits the budget. Used when the brain fails, and to repair its plan.
// a model that can't reach the wanted resolution looks worse on screen than its score says
function scoreFor(m, need, res = "720p") {
  let s = m.q;
  if (RES_ORDER.indexOf(pickRes(m, res)) < RES_ORDER.indexOf(res)) s -= 1.5;
  if (need.faces && m.tags.includes("faces")) s += need.closeup ? 2 : 1; // close-ups are where face quality shows
  if (need.dialogue && (m.tags.includes("dialogue+audio") || m.tags.includes("talking-head"))) s += 1;
  if (need.cartoon && (m.tags.includes("cartoon") || m.tags.includes("anime"))) s += 1;
  if (need.motion && m.tags.includes("motion")) s += 0.5;
  return s;
}
function bestWithin(cands, need, seconds, res, audio, budget) {
  const opts = cands.map((m) => { const r = pickRes(m, res), d = snap(m, seconds); return { m, res: r, d, cost: rate(m, r, audio) * d, score: scoreFor(m, need, res) }; })
    .filter((o) => isFinite(o.cost));
  const fit = opts.filter((o) => o.cost <= budget + 1e-9);
  const pool = fit.length ? fit : opts.sort((a, b) => a.cost - b.cost).slice(0, 1);
  // highest score; among near-equal scores (within 0.5) the cheaper one
  return pool.sort((a, b) => (Math.abs(b.score - a.score) > 0.5 ? b.score - a.score : a.cost - b.cost))[0] || null;
}

function rulesClip(req, cands) {
  const need = needs(req.prompt + " " + (req.theme || ""));
  const seconds = req.duration || 5, res = req.resolution || "720p", audio = req.audio !== false;
  const pick = bestWithin(cands, need, seconds, res, audio, req.budget ?? Infinity);
  if (!pick) return null;
  const alts = cands.filter((m) => m.id !== pick.m.id).map((m) => ({ m, s: scoreFor(m, need), c: rate(m, pickRes(m, res), audio) * snap(m, seconds) }))
    .sort((a, b) => b.s - a.s || a.c - b.c);
  const cheaper = alts.filter((a) => a.c < pick.cost).sort((a, b) => b.s - a.s)[0], better = alts.find((a) => a.s > pick.score);
  return {
    model: pick.m.id, duration: pick.d, resolution: pick.res, audio: audio && !!pick.m.audio,
    pictureFirst: need.faces && (pick.m.frames || []).includes("first_frame"),
    enhance: pick.res === "480p" ? { upscale: "720p", smooth: false } : null,
    reason: `Best quality for the budget among ${cands.length} models (${pick.m.name}, quality ${pick.m.q}/10${need.faces ? ", good with faces" : ""}).`,
    alternatives: [better && { model: better.m.id, why: "Higher quality, costs more" }, cheaper && { model: cheaper.m.id, why: "Cheaper" }].filter(Boolean),
  };
}
function rulesStory(req, cands) {
  const scenes = req.scenes || [], res = req.resolution || "720p";
  const total = req.budget ?? Infinity;
  // key scenes get the larger share of the budget
  const weight = scenes.map((s) => (s.key ? 2 : 1)), wsum = weight.reduce((a, b) => a + b, 0) || 1;
  const per = scenes.map((s, i) => {
    const need = needs(s.prompt + " " + (req.theme || ""));
    const pick = bestWithin(cands, need, s.seconds || 4, res, false, (total * weight[i]) / wsum);
    // storyboard pictures keep people consistent; scenes without people don't need one
    return pick && { i, model: pick.m.id, duration: pick.d, resolution: pick.res, ...(need.faces ? {} : { picture: false }), reason: `${s.key ? "Key scene" : "Filler"}: ${pick.m.name} (quality ${pick.m.q}/10) fits its share of the budget.` };
  }).filter(Boolean);
  // money left over: upgrade the scenes where it shows most (key scenes, close-ups), best gain per extra dollar first
  if (isFinite(total)) {
    const plan = { scenes: per, resolution: res, pictureFirst: true };
    for (let guard = 0; guard < 40; guard++) {
      const left = total - costStory(plan, Object.fromEntries(cands.map((m) => [m.id, m]))).total;
      let best = null;
      for (const s of per) {
        const sc = scenes[s.i], need = needs(sc.prompt + " " + (req.theme || "")), w = (sc.key ? 2 : 1) * (need.closeup ? 1.5 : 1);
        const cur = cands.find((m) => m.id === s.model), now = scoreFor(cur, need, res);
        for (const m of cands) {
          const d = snap(m, sc.seconds || 4), extra = rate(m, pickRes(m, res), false) * d - s.cost, gain = (scoreFor(m, need, res) - now) * w;
          if (gain > 0 && extra > 0 && extra <= left + 1e-9 && (!best || gain / extra > best.gain / best.extra)) best = { s, m, d, gain, extra };
        }
      }
      if (!best) break;
      Object.assign(best.s, { model: best.m.id, duration: best.d, resolution: pickRes(best.m, res), reason: `${scenes[best.s.i].key ? "Key scene" : "Scene"}: upgraded to ${best.m.name} (quality ${best.m.q}/10) with budget left over.` });
    }
  }
  return { scenes: per, resolution: res, pictureFirst: true, connect: true, reason: "Key scenes get the better models, filler scenes the cheaper ones, all within your budget." };
}

// ---------- the brain ----------
function brainPrompt(req, cands) {
  const audio = req.audio !== false && req.page !== "story";
  const cat = cands.map((m) => ({
    id: m.id, name: m.name, tier: m.tier, quality: m.q, tags: m.tags,
    usd_per_sec: Object.fromEntries(m.res.map((r) => [r, round(rate(m, r, audio), 4)])),
    lengths: m.durs.length > 8 ? `${m.durs[0]}-${m.durs[m.durs.length - 1]}` : m.durs.join(","),
    start_end_frames: (m.frames || []).includes("last_frame") ? "first+last" : (m.frames || []).includes("first_frame") ? "first" : "none",
    sound: m.audio === "always" ? "always" : m.audio ? "optional" : "none",
  }));
  const rules = [
    "Goal: the HIGHEST quality result that fits the budget. Spend the budget where viewers notice it (faces, close-ups, the hook, key moments); use cheaper models for B-roll, wide shots and simple motion.",
    "Prices are dollars per second; cost = price x seconds. Never exceed the budget.",
    "Vertical Reels/Shorts look the same at 720p as 1080p on phones: use 720p, 1080p only when the request is a hero/YouTube shot and it still fits.",
    "Short shots (3-6 s) drift less (faces, hands); prefer them unless the action needs longer.",
    "pictureFirst (draw a still first, then animate it) keeps faces and look consistent: use it for people and characters when the model supports a first frame. It costs $0.02 per clip (per scene in a story) and that counts toward the budget.",
    "Every model's lowest price may be at a lower resolution than asked; a 480p-only model looks worse at 720p, so count that against it.",
    "enhance upscales 480p to 720p for free on our server: use it when you choose 480p to save money.",
    "The theme field is the chosen look (and main character). For an animated look (2D, 3D, anime, meme), prefer models tagged cartoon or anime; for a realistic look, models tagged realism or faces.",
    "Only use model ids from the catalog, copied exactly (e.g. \"google/veo-3.1-fast\"). Explain choices in one short plain sentence each.",
  ];
  const task = req.page === "story"
    ? { what: "a story video made of these scenes (silent clips, narration is added later)", scenes: (req.scenes || []).map((s, i) => ({ i, title: s.title, prompt: String(s.prompt || "").slice(0, 300), seconds: s.seconds, key: !!s.key })) }
    : { what: { clip: "one video clip", ugc: "a UGC-style product review clip: a realistic person talking to a phone camera holding a product", poses: "a short pose clip of a saved influencer, starting from their picture", motion: "copy the movement of a reference video onto a character" }[req.page], prompt: String(req.prompt || "").slice(0, 1200), wanted_seconds: req.duration || null };
  const shape = req.page === "story"
    ? '{"resolution":"720p","pictureFirst":true,"connect":true,"reason":"...","scenes":[{"i":0,"model":"<id>","duration":4,"reason":"..."}]}'
    : '{"model":"<id>","duration":5,"resolution":"720p","audio":true,"pictureFirst":false,"enhance":null or {"upscale":"720p","smooth":false},"reason":"...","alternatives":[{"model":"<id>","why":"..."}]}';
  return [
    { role: "system", content: "You are the Director of an AI video studio. You choose which video model makes each shot and how, for the best quality within budget.\nRules:\n- " + rules.join("\n- ") + "\nReply with ONLY JSON in this shape: " + shape },
    { role: "user", content: JSON.stringify({ task, budget_usd: req.budget ?? null, aspect: req.aspect || "9:16", sound_wanted: audio, theme: req.theme || null, models: cat }) },
  ];
}
function parseJSON(txt) {
  const t = String(txt || "").replace(/```(json)?/g, "");
  try { return JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { return null; }
}

// ---------- check the plan against the catalog and the budget; compute the real cost ----------
function costClip(plan, catalog, req) {
  const m = catalog[plan.model];
  const video = rate(m, plan.resolution, plan.audio) * plan.duration;
  const still = plan.pictureFirst ? STILL : 0;
  return { video: round(video), still, total: round(video + still) };
}
const STILL = 0.02;
// the brain sometimes writes a model's name, drops the vendor, or changes case: map that back to a real id
function resolveId(v, cands) {
  const t = String(v || "").trim().toLowerCase();
  if (!t) return null;
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const hit = cands.find((m) => m.id.toLowerCase() === t) || cands.find((m) => m.id.toLowerCase().split("/").pop() === t.split("/").pop()) ||
    cands.find((m) => norm(m.name) === norm(t)) || cands.find((m) => norm(m.id) === norm(t));
  if (hit) return hit.id;
  // part of a name ("Veo 3.1 Fast" for "Google Veo 3.1 Fast"), only when exactly one model matches
  const part = norm(t).length >= 4 ? cands.filter((m) => norm(m.name).includes(norm(t))) : [];
  return part.length === 1 ? part[0].id : null;
}
function validateClip(raw, catalog, cands, req) {
  const id = raw && resolveId(raw.model, cands);
  if (!id) return null;
  const m = catalog[id];
  const plan = {
    model: m.id, duration: snap(m, raw.duration || req.duration || 5), resolution: m.res.includes(raw.resolution) ? raw.resolution : pickRes(m, "720p"),
    audio: req.audio === false ? false : m.audio === "always" ? true : m.audio ? raw.audio !== false : false,
    pictureFirst: !!raw.pictureFirst && (m.frames || []).includes("first_frame") && req.page !== "poses" && req.page !== "motion",
    enhance: raw.enhance && typeof raw.enhance === "object" ? { upscale: ["720p", "1080p"].includes(raw.enhance.upscale) ? raw.enhance.upscale : "720p", smooth: !!raw.enhance.smooth } : null,
    reason: String(raw.reason || "").slice(0, 300),
    alternatives: (Array.isArray(raw.alternatives) ? raw.alternatives : []).map((a) => a && { model: resolveId(a.model, cands), why: String(a.why || "").slice(0, 120) })
      .filter((a, i, all) => a && a.model && a.model !== m.id && all.findIndex((b) => b && b.model === a.model) === i).slice(0, 2),
  };
  if (plan.enhance && RES_ORDER.indexOf(plan.enhance.upscale) <= RES_ORDER.indexOf(plan.resolution)) plan.enhance = null;
  return plan;
}
// scenes the brain skipped or got wrong are filled in by the rules (if it got most of them wrong, the rules plan all)
function validateStory(raw, catalog, cands, req) {
  if (!raw || !Array.isArray(raw.scenes)) return null;
  const list = raw.scenes.filter((s) => s && typeof s === "object");
  const byI = new Map(list.map((s, k) => [Number.isInteger(Number(s.i)) ? Number(s.i) : k, s]));
  const res = ["480p", "720p", "1080p"].includes(raw.resolution) ? raw.resolution : "720p";
  const all = req.scenes || [];
  let fixed = 0;
  const scenes = all.map((s, i) => {
    const r = byI.get(i), id = r && resolveId(r.model, cands), m = id && catalog[id];
    if (m) return { i, model: m.id, duration: snap(m, r.duration || s.seconds), resolution: pickRes(m, res), reason: String(r.reason || "").slice(0, 200), ...(r.picture === false ? { picture: false } : {}) };
    fixed++;
    const one = rulesStory({ ...req, scenes: [s], budget: req.budget > 0 ? req.budget / Math.max(1, all.length) : undefined }, cands).scenes[0];
    return one ? { ...one, i, reason: "Chosen by the built-in rules (the Director skipped this scene)." } : null;
  });
  if (scenes.some((s) => !s) || fixed > all.length / 2) return null;
  return { scenes, resolution: res, pictureFirst: raw.pictureFirst !== false, connect: raw.connect !== false, reason: String(raw.reason || "").slice(0, 300), repaired: fixed };
}
function costStory(plan, catalog) {
  let video = 0, pics = 0;
  for (const s of plan.scenes) {
    const m = catalog[s.model]; s.resolution = pickRes(m, s.resolution || plan.resolution); s.cost = round(rate(m, s.resolution, false) * s.duration); video += s.cost;
    if (plan.pictureFirst && s.picture !== false) pics++;
  }
  const still = pics * STILL;
  return { video: round(video), still: round(still), total: round(video + still) };
}
// over budget: give up the least visible quality first until it fits. Possible changes: a cheaper model for one
// scene, a shorter clip (never under 3 s), or no storyboard picture for a scene. Key scenes count double, so filler
// scenes give way first. Returns the warnings shown to the user.
const MIN_SCENE = 3;
function fitStory(plan, catalog, cands, req) {
  const warn = [];
  if (!(req.budget > 0)) return warn;
  for (let guard = 0; guard < 80; guard++) {
    const c = costStory(plan, catalog), excess = c.total - req.budget;
    if (excess <= 1e-9) return warn;
    const moves = [];
    for (const s of plan.scenes) {
      const sc = (req.scenes || [])[s.i] || {}, cur = catalog[s.model], need = needs(sc.prompt), key = (sc.key ? 2 : 1) * (need.closeup ? 1.5 : 1);
      const now = scoreFor(cur, need, plan.resolution);
      for (const m of cands) {
        const r = pickRes(m, plan.resolution), d = snap(m, s.duration), cost = rate(m, r, false) * d;
        if (d >= Math.min(MIN_SCENE, s.duration) && cost < s.cost - 1e-9) moves.push({ s, kind: "model", m, d, saved: s.cost - cost, loss: Math.max(0, now - scoreFor(m, need, plan.resolution)) * key + 0.05 });
      }
      const shorter = cur.durs.filter((d) => d < s.duration && d >= MIN_SCENE).pop();
      if (shorter) moves.push({ s, kind: "len", d: shorter, saved: s.cost - rate(cur, s.resolution, false) * shorter, loss: 0.4 * (s.duration - shorter) * key });
      if (plan.pictureFirst && s.picture !== false) moves.push({ s, kind: "pic", saved: STILL, loss: (need.faces ? 1.5 : 0.2) * key });
    }
    if (moves.length) {
      // one change that covers the whole gap with the least loss, unless a smaller step loses even less
      const cover = moves.filter((m) => m.saved >= excess - 1e-9).sort((a, b) => a.loss - b.loss)[0];
      const step = moves.slice().sort((a, b) => a.loss / a.saved - b.loss / b.saved)[0];
      const mv = cover && cover.loss <= step.loss ? cover : step, cur = catalog[mv.s.model];
      if (mv.kind === "model") { warn.push(`Scene ${mv.s.i + 1}: ${cur.name} → ${mv.m.name} to stay in budget.`); mv.s.reason = `Changed from ${cur.name} to ${mv.m.name} to fit the budget.`; mv.s.model = mv.m.id; mv.s.resolution = pickRes(mv.m, plan.resolution); mv.s.duration = mv.d; }
      else if (mv.kind === "len") { warn.push(`Scene ${mv.s.i + 1}: shortened to ${mv.d} s to stay in budget.`); mv.s.duration = mv.d; }
      else { warn.push(`Scene ${mv.s.i + 1}: no storyboard picture, to stay in budget.`); mv.s.picture = false; }
      continue;
    }
    if (plan.resolution !== "480p") { plan.resolution = "480p"; warn.push("All scenes at 480p to stay in budget (Enhance can upscale them for free)."); continue; }
    if (plan.pictureFirst) { plan.pictureFirst = false; warn.push("Storyboard pictures skipped to stay in budget."); continue; }
    warn.push(`Even the cheapest plan is over your $${req.budget.toFixed(2)} budget.`);
    return warn;
  }
  return warn;
}
function fitClip(plan, catalog, cands, req) {
  const warn = [];
  if (!(req.budget > 0)) return warn;
  let c = costClip(plan, catalog, req);
  if (c.total <= req.budget + 1e-9) return warn;
  if (plan.pictureFirst) { plan.pictureFirst = false; c = costClip(plan, catalog, req); warn.push("Picture first skipped to stay in budget."); }
  if (c.total <= req.budget + 1e-9) return warn;
  const pick = bestWithin(cands, needs(req.prompt), plan.duration, plan.resolution, plan.audio, req.budget);
  if (pick) { warn.push(`${catalog[plan.model].name} → ${pick.m.name} to stay in your $${req.budget.toFixed(2)} budget.`); Object.assign(plan, { model: pick.m.id, duration: pick.d, resolution: pick.res, audio: plan.audio && !!pick.m.audio }); }
  if (costClip(plan, catalog, req).total > req.budget + 1e-9) warn.push(`Even the cheapest option is over your $${req.budget.toFixed(2)} budget.`);
  return warn;
}

// a brain pick far below what the budget buys (e.g. a 480p draft model for a face close-up with money to spare)
// is swapped for the rules' best pick, so Auto never quietly gives a worse clip than the budget allows
function qualityFloor(plan, catalog, cands, req) {
  if (!(req.budget > 0)) return null;
  const need = needs(req.prompt + " " + (req.theme || "")), res = req.resolution || "720p", pic = plan.pictureFirst ? STILL : 0;
  const best = bestWithin(cands, need, plan.duration, res, plan.audio, req.budget - pic), cur = catalog[plan.model];
  if (!best || best.m.id === cur.id || best.cost + pic > req.budget + 1e-9) return null;
  if (best.score - scoreFor(cur, need, res) < 2) return null;
  const note = `${best.m.name} (quality ${best.m.q}/10) instead of ${cur.name} (${cur.q}/10): clearly better and still within your budget.`;
  plan.alternatives = [{ model: cur.id, why: "The first pick, cheaper" }, ...plan.alternatives.filter((a) => a.model !== best.m.id && a.model !== cur.id)].slice(0, 2);
  Object.assign(plan, { model: best.m.id, duration: best.d, resolution: best.res, audio: plan.audio && !!best.m.audio, pictureFirst: plan.pictureFirst && (best.m.frames || []).includes("first_frame") });
  if (plan.enhance && RES_ORDER.indexOf(plan.enhance.upscale) <= RES_ORDER.indexOf(plan.resolution)) plan.enhance = null;
  plan.reason = note;
  return note;
}

// main entry. callBrain(messages) -> { text, cost } or throws.
// opts.cache (a Map) gives the same plan for the same request for 10 minutes, so asking twice doesn't flip-flop.
async function decide(req, { catalog, available, callBrain, cache }) {
  if (!PAGES.includes(req.page)) throw Object.assign(new Error("Unknown page."), { status: 400 });
  const cands = candidates(catalog, req, available);
  if (!cands.length) throw Object.assign(new Error("No video model can do this (check the aspect ratio)."), { status: 400 });
  const key = cache && JSON.stringify([req, cands.map((m) => m.id + ":" + rate(m, "720p", true))]);
  const hit = key && cache.get(key);
  if (hit && Date.now() - hit.t < 600000) return { ...structuredClone(hit.out), brainCost: 0, cached: true };
  const story = req.page === "story";
  const check = (raw) => raw && (story ? validateStory(raw, catalog, cands, req) : validateClip(raw, catalog, cands, req));
  // up to two tries: the second tells the brain exactly what was wrong with the first reply
  let plan = null, brainCost = 0, source = "brain", brainError = null, tries = 0;
  const msgs = brainPrompt(req, cands);
  while (tries < 2 && !plan) {
    tries++;
    let text = "";
    try { const r = await callBrain(msgs); brainCost += r.cost || 0; text = r.text; }
    catch (e) { brainError = e.message; if (/time|abort/i.test(e.message)) break; continue; }
    const raw = parseJSON(text);
    plan = check(raw);
    if (!plan) {
      brainError = raw ? "The Director's plan used models or scenes that don't exist." : "The Director's reply wasn't valid JSON.";
      const fix = raw ? "use ONLY model ids from the catalog, exactly as written" + (story ? ", with one entry for every scene i" : "") : "it was not valid JSON";
      msgs.push({ role: "assistant", content: String(text || "(empty)").slice(0, 4000) }, { role: "user", content: `That reply can't be used: ${fix}. Reply again with ONLY the JSON object.` });
    }
  }
  if (plan) brainError = null;
  if (!plan) { source = "rules"; plan = story ? rulesStory(req, cands) : rulesClip(req, cands); }
  if (!plan) throw Object.assign(new Error("Couldn't make a plan for this."), { status: 400 });
  if (story && plan.repaired) source = "brain+rules";
  const upgraded = !story && source === "brain" ? qualityFloor(plan, catalog, cands, req) : null;
  const warnings = story ? fitStory(plan, catalog, cands, req) : fitClip(plan, catalog, cands, req);
  const cost = story ? costStory(plan, catalog) : costClip(plan, catalog, req);
  // names for the page, so it doesn't need a second lookup
  const name = (id) => (catalog[id] || {}).name || id;
  if (story) plan.scenes.forEach((s) => (s.name = name(s.model)));
  else { plan.name = name(plan.model); plan.alternatives.forEach((a) => { a.name = name(a.model); const m = catalog[a.model]; a.cost = round(rate(m, pickRes(m, plan.resolution), plan.audio) * snap(m, plan.duration)); }); }
  if (story && plan.repaired) warnings.unshift(`${plan.repaired} scene${plan.repaired > 1 ? "s" : ""} filled in by the built-in rules.`);
  const out = { plan, cost, budget: req.budget ?? null, warnings, source, brainCost: round(brainCost, 5), brainError, candidates: cands.length, tries };
  if (key && source !== "rules") { cache.set(key, { t: Date.now(), out: structuredClone(out) }); if (cache.size > 50) cache.delete(cache.keys().next().value); }
  return out;
}

module.exports = { decide, candidates, resolveId, qualityFloor, rulesClip, rulesStory, validateClip, validateStory, fitStory, fitClip, costStory, costClip, needs, brainPrompt, parseJSON, rate, snap, STILL };
