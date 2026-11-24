// Story mode routes: plan a script into scenes, lock the cast (character sheet + per-scene first frames), voice,
// stitch clips into one video, and keep story history on the server.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { mixStory, AMBIENCES, EFFECTS } = require("../lib/sound");
const { MOODS } = require("../lib/music");
const hing = require("../lib/hinglish"); // Hinglish mode (X-Lang: hinglish)

// How a scene fits its narration (vd = clip seconds, ad = narration seconds). Nothing is ever cut off: the voice is
// sped up a touch first, then the clip slowed a little, and only then does the last frame hold. D = scene length.
const BREATH = 0.35; // pause after each line so scenes don't run into each other
function fitScene(vd, ad, budget) {
  if (!ad) return { D: vd || 1, tempo: 1, slow: 1, hold: 0 };
  if (!vd) return { D: ad + BREATH, tempo: 1, slow: 1, hold: 0 };
  const need = ad + BREATH;
  if (need <= vd) return { D: vd, tempo: 1, slow: 1, hold: 0 };
  const tempo = Math.min(budget ? 1.08 : 1.12, need / vd); // a light speed-up still sounds natural
  const needT = ad / tempo + BREATH;
  const slow = Math.max(1, Math.min(budget ? 1.5 : 1.3, needT / vd));
  const hold = Math.max(0, needT - vd * slow);
  return { D: Math.max(vd, needT), tempo, slow, hold };
}

module.exports = function storyRoutes(ctx) {
  const { STORE, DATA, API, getKey, orFetch, orHeaders, send, readBody, run, tts, spend, settings, serveMp4, mediaDuration, hasAudio, glitchFilter, renderSlot } = ctx;
  const WORK = path.join(STORE, "work");
  const CAST = path.join(WORK, "cast");
  fs.mkdirSync(CAST, { recursive: true });

  // ---------- stitch jobs: kept in memory while running and in work/<sid>/status.json, so a restart can't lose them ----------
  const stitches = new Map();
  const statusFile = (sid) => path.join(WORK, sid, "status.json");
  const saveStatus = (sid, st) => { try { fs.writeFileSync(statusFile(sid), JSON.stringify(st)); } catch {} };
  const readStatus = (sid) => stitches.get(sid) || (() => { try { return JSON.parse(fs.readFileSync(statusFile(sid), "utf8")); } catch { return null; } })();
  // anything still "running" on disk was cut off by a restart
  for (const d of fs.existsSync(WORK) ? fs.readdirSync(WORK) : []) {
    const st = /^[a-f0-9]{12}$/.test(d) && readStatus(d);
    if (st && st.status === "running") saveStatus(d, { ...st, status: "failed", error: "The server restarted while this was being stitched. Click the button again: finished clips are reused, nothing is charged twice." });
  }
  const busy = (sid) => stitches.get(sid)?.status === "running";

  // ---------- story history, shared by every device (data/stories.json, newest first) ----------
  const STORIES = path.join(DATA, "stories.json");
  const readStories = () => { try { return JSON.parse(fs.readFileSync(STORIES, "utf8")); } catch { return []; } };
  const writeStories = (a) => { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(STORIES, JSON.stringify(a.slice(0, 40))); };

  const imageCall = async (body) => {
    const r = await orFetch(`${API}/images`, { method: "POST", headers: orHeaders(), body: JSON.stringify(body) }, { safe: false });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error?.message || `Image failed (${r.status})`), { status: r.status });
    const d = j.data?.[0];
    if (!d?.b64_json) throw new Error("The image model returned no picture.");
    return { d, cost: j.usage?.cost || 0 };
  };
  const castFile = (id) => /^[a-f0-9]{16}$/.test(id || "") && ["png", "jpg", "webp"].map((e) => path.join(CAST, `${id}.${e}`)).find((f) => fs.existsSync(f));
  const dataUrl = (f) => `data:image/${path.extname(f).slice(1).replace("jpg", "jpeg")};base64,` + fs.readFileSync(f).toString("base64");

  return { busy, handle: async function handle(req, res, url) {
    let m;
    // ---- plan a script into scenes ----
    if (req.method === "POST" && url.pathname === "/api/plan") {
      const b = await readBody(req);
      if (!b.script || !b.script.trim()) return send(res, 400, { error: "Paste a script first." }), true;
      const H = hing.isHinglish(req), total = Number(b.total) || 30, model = H ? settings.get().directorModel || "google/gemini-3.5-flash" : settings.get().textModel;
      const sys = [
        "You are a feature-film director and cinematographer planning a short narrated film for an AI text-to-video model. Plan it shot by shot so it looks and feels like a real movie scene, not a slideshow.",
        `LENGTH: about ${total} seconds in total; each scene 3 to 5 seconds (integers; short shots look better on Reels and Shorts and hide the drift of faces and hands that long AI clips show; use several shots for one narration beat). The seconds must add up to about ${total}.`,
        "VISUAL THEME: first decide one look for the whole film that fits the story's mood: colour palette (2-3 named colours), lighting (time of day, light sources, contrast), era and texture. Every scene uses it, so the film feels like one piece.",
        "BIBLE: write a 'bible' with, for EACH recurring character, one sentence with name, age, build, face, hair and exact clothing with colours; one sentence for the main setting; and one sentence starting 'Look:' with the visual theme. It is added to every scene so they stay consistent.",
        "SHOTS: plan coverage like a film editor: open with an establishing wide shot, move to medium shots for action, close-ups for emotion and reveals, and insert shots (an object, a hand, a screen) for clues. Vary the shot size from cut to cut; never two identical framings in a row. Compose with intent: rule of thirds, depth (foreground, subject, background), motivated light.",
        "CAMERA AND MOTION: the camera is locked off at one fixed angle in each shot (no zooms, pans, angle changes or shake unless one slow, motivated move is essential to the story's single biggest moment). Movement is smooth, slow and physically natural: breathing, a turn of the head, a hand reaching, a door opening. Only the characters (and the one object they interact with) move; the background stays still. No one talks on screen: the narrator tells the story, characters do not speak or mouth words.",
        "SCENE PROMPT: self-contained, two or three vivid present-tense sentences in this order: shot size and lens feel (e.g. 'Close-up, 50mm'), the subject named by their bible appearance and the one clear action, the setting, the lighting and colours of the look, the mood. No on-screen text, no camera jargon beyond the shot size.",
        "CONTINUITY: continues:true only when a scene directly continues the previous one in the same place with the same characters and uninterrupted action (it starts from the previous scene's last frame); continues:false for the first scene and any cut to a new place or time. key:true ONLY for the roughly 30% that matter most visually (hook, reveal, twist, emotional peak); the rest key:false.",
        "NARRATION: for every scene write \"narration\", what a calm narrator says during it, natural spoken language, at most 2.3 words per second of the scene length, so all the lines read as one continuous story (empty string only for a deliberately silent beat).",
        `SOUND: pick "music" for the whole film from ${MOODS.join(", ")} or none, and "ambience" (the place sound under everything) from ${AMBIENCES.join(", ")} or none. For each scene pick "sfx", a sound effect on its cut, from ${EFFECTS.join(", ")} or none: use effects sparingly (about one scene in three), on reveals, shocks and transitions; riser builds into the scene, impact lands on it.`,
        ...(H ? [hing.RULE + " In the JSON, each scene's \"narration\" is the Hinglish part; \"title\", \"bible\" and every scene \"prompt\" (what the video model reads) stay plain English, and nobody speaks on screen."] : []),
        `Aspect ratio ${b.aspect || "9:16"}.` + (b.style ? " Visual style: " + b.style : ""),
        'Reply with ONLY valid JSON, no markdown: {"bible":"...","sound":{"music":"suspense","ambience":"night"},"scenes":[{"title":"...","prompt":"...","seconds":4,"key":true,"continues":false,"narration":"...","sfx":"none"}]}',
      ].join("\n");
      const r = await orFetch(`${API}/chat/completions`, {
        method: "POST", headers: orHeaders(),
        body: JSON.stringify({ model, max_tokens: 7000, reasoning: H ? { effort: "low" } : { enabled: false }, messages: [{ role: "system", content: sys }, { role: "user", content: b.script.trim() }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: j.error?.message || "Planning failed" }), true;
      spend.log("Story", j.usage?.cost, model);
      const txt = j.choices?.[0]?.message?.content || "";
      try {
        const plan = (H ? hing.scrubDeep : (x) => x)(JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1)));
        if (!Array.isArray(plan.scenes) || !plan.scenes.length) throw new Error("no scenes");
        // only sounds this server can make
        const s = plan.sound || {};
        plan.sound = { music: MOODS.includes(s.music) ? s.music : "none", ambience: AMBIENCES.includes(s.ambience) ? s.ambience : "none" };
        plan.scenes.forEach((sc) => { sc.sfx = EFFECTS.includes(sc.sfx) ? sc.sfx : "none"; });
        return send(res, 200, plan), true;
      } catch {
        return send(res, 502, { error: "Planner returned invalid JSON. Try again." }), true;
      }
    }

    // ---- character lock 1/2: one reference sheet of the whole cast (optionally built on saved influencers) ----
    if (req.method === "POST" && url.pathname === "/api/cast") {
      const b = await readBody(req);
      const bible = String(b.bible || "").trim().slice(0, 2500);
      if (!bible) return send(res, 400, { error: "The character bible is empty." }), true;
      const model = settings.get().imageModel;
      const refs = (Array.isArray(b.influencer_ids) ? b.influencer_ids : []).slice(0, 3).map((id) => /^[\w-]+$/.test(id) && ctx.imgFile(id)).filter(Boolean);
      const prompt = "Character reference sheet for an animated or filmed story. Show every character described below standing side by side, full body, front view, neutral pose, evenly lit, on a plain light-grey studio background, " +
        "so their faces, hair, body shape and exact clothing colors are clearly visible. No text, no labels, no panels or borders. " +
        (refs.length ? `Image${refs.length > 1 ? "s 1-" + refs.length : " 1"} show${refs.length > 1 ? "" : "s"} real reference(s) for the main character(s): keep their faces identical. ` : "") +
        `Characters and setting: ${bible}` + (b.style ? ` Visual style: ${String(b.style).slice(0, 300)}` : "");
      try {
        const { d, cost } = await imageCall({ model, prompt, n: 1, aspect_ratio: "16:9", ...(refs.length ? { input_references: refs.map((f) => ({ type: "image_url", image_url: { url: dataUrl(f) } })) } : {}) });
        const id = crypto.randomBytes(8).toString("hex"), ext = /jpe?g/.test(d.media_type || "") ? "jpg" : /webp/.test(d.media_type || "") ? "webp" : "png";
        fs.writeFileSync(path.join(CAST, `${id}.${ext}`), Buffer.from(d.b64_json, "base64"));
        spend.log("Story", cost, model);
        return send(res, 200, { id, url: `/api/cast/${id}`, cost }), true;
      } catch (e) { return send(res, e.status || 502, { error: "Cast sheet failed: " + e.message }), true; }
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/cast\/([a-f0-9]{16})$/))) {
      const f = castFile(m[1]);
      if (!f) { res.writeHead(404); return res.end("Not found"), true; }
      res.writeHead(200, { "Content-Type": "image/" + path.extname(f).slice(1).replace("jpg", "jpeg"), "Cache-Control": "private, max-age=604800" });
      return fs.createReadStream(f).pipe(res), true;
    }
    // ---- character lock 2/2: a first frame for one scene, drawn from the cast sheet ----
    if (req.method === "POST" && url.pathname === "/api/keyframe") {
      const b = await readBody(req);
      const f = castFile(b.cast);
      if (!f) return send(res, 400, { error: "Make the cast sheet first." }), true;
      const p = String(b.prompt || "").trim().slice(0, 1500);
      if (!p) return send(res, 400, { error: "Scene prompt is empty." }), true;
      const ar = ["9:16", "16:9", "1:1"].includes(b.aspect_ratio) ? b.aspect_ratio : "9:16";
      const model = settings.get().imageModel;
      const prompt = `Image 1 is the character reference sheet. Create the opening frame of this scene: ${p} ` +
        "Every character must look exactly like on the sheet: same face, hair, skin tone, body shape and the same clothes and colors. " +
        `One single full-frame cinematic film still composed for ${ar}, characters at natural size in the scene (not a lineup), no text, no panels, no borders.` +
        (b.style ? ` Visual style: ${String(b.style).slice(0, 300)}` : "");
      try {
        const { d, cost } = await imageCall({ model, prompt, n: 1, aspect_ratio: ar, input_references: [{ type: "image_url", image_url: { url: dataUrl(f) } }] });
        spend.log("Story", cost, model);
        return send(res, 200, { image: `data:${d.media_type || "image/png"};base64,${d.b64_json}`, cost }), true;
      } catch (e) { return send(res, e.status || 502, { error: "Scene frame failed: " + e.message }), true; }
    }

    // ---- storyboard: one still per scene, drawn in the theme (and from the character sheet / saved character),
    //      approved or swapped before any video is paid for; the video then starts from it ----
    if (req.method === "POST" && url.pathname === "/api/still") {
      const b = await readBody(req);
      const p = String(b.prompt || "").trim().slice(0, 1500);
      if (!p) return send(res, 400, { error: "Scene prompt is empty." }), true;
      const ar = ["9:16", "16:9", "1:1"].includes(b.aspect_ratio) ? b.aspect_ratio : "9:16";
      const st = settings.get(), model = st.imageModel;
      const theme = b.no_theme ? null : ctx.themes.get(typeof b.theme_id === "string" ? b.theme_id : st.themeId);
      const infId = /^[\w-]+$/.test(b.influencer_id || "") ? b.influencer_id : null;
      const inf = infId && ctx.readInf().find((x) => x.id === infId);
      const refs = [], said = [];
      const cast = castFile(b.cast);
      if (cast) { refs.push(dataUrl(cast)); said.push(`Image ${refs.length} is the character reference sheet: every character looks exactly like on it (face, hair, body, clothes, colours).`); }
      const infImg = inf && ctx.imgFile(inf.id);
      if (infImg && !cast) { refs.push(dataUrl(infImg)); said.push(`Image ${refs.length} is the main character: keep the same face, hair and look.`); }
      const prompt = `${said.join(" ")} Create the opening frame of this scene as one single full-frame film still composed for ${ar}: ${p}` +
        (inf && inf.desc ? ` Main character, exactly: ${inf.desc}.` : "") + ctx.themeText(theme, (inf && inf.desc) || (b.no_theme ? "" : st.character)) +
        (b.style ? ` Visual style: ${String(b.style).slice(0, 300)}` : "") + " Characters at natural size in the scene, no text, no panels, no borders.";
      try {
        const { d, cost } = await imageCall({ model, prompt, n: 1, aspect_ratio: ar, ...(refs.length ? { input_references: refs.map((u) => ({ type: "image_url", image_url: { url: u } })) } : {}) });
        const id = "s" + crypto.randomBytes(8).toString("hex"), ext = /jpe?g/.test(d.media_type || "") ? "jpg" : /webp/.test(d.media_type || "") ? "webp" : "png";
        fs.writeFileSync(path.join(ctx.STILLS, `${id}.${ext}`), Buffer.from(d.b64_json, "base64"));
        spend.log("Storyboard", cost, model);
        return send(res, 200, { id, url: `/api/still/${id}`, cost }), true;
      } catch (e) { return send(res, e.status || 502, { error: "Storyboard picture failed: " + e.message }), true; }
    }
    // swap a scene's picture for your own (an AI-made image; photos of real people get blocked by the video models)
    if (req.method === "POST" && url.pathname === "/api/stills/upload") {
      const b = await readBody(req, 12e6);
      const mm = String(b.image || "").match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (!mm) return send(res, 400, { error: "Use a JPG, PNG or WEBP picture." }), true;
      const id = "s" + crypto.randomBytes(8).toString("hex");
      fs.writeFileSync(path.join(ctx.STILLS, `${id}.${mm[1] === "jpeg" ? "jpg" : mm[1]}`), Buffer.from(mm[2], "base64"));
      return send(res, 200, { id, url: `/api/still/${id}` }), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/still\/(s[a-f0-9]{16})$/))) {
      const f = ctx.stillFile(m[1]);
      if (!f) { res.writeHead(404); return res.end("Not found"), true; }
      res.writeHead(200, { "Content-Type": "image/" + path.extname(f).slice(1).replace("jpg", "jpeg"), "Cache-Control": "private, max-age=604800" });
      return fs.createReadStream(f).pipe(res), true;
    }

    // ---- voice preview ----
    if (req.method === "POST" && url.pathname === "/api/tts") {
      const b = await readBody(req);
      if (!b.text || !b.model) return send(res, 400, { error: "text and model required" }), true;
      try {
        const buf = await tts({ model: b.model, voice: b.voice, text: String(b.text).slice(0, 600), instructions: b.instructions, lang: hing.isHinglish(req) ? "hinglish" : undefined });
        res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": buf.length });
        return res.end(buf), true;
      } catch (e) { return send(res, 502, { error: e.message }), true; }
    }

    // ---- stitch: download finished clips, voice them, normalise, join, optional glitch look ----
    if (req.method === "POST" && url.pathname === "/api/stitch") {
      const b = await readBody(req);
      const ids = Array.isArray(b.ids) ? b.ids : [];
      if (!ids.length || !ids.every((i) => /^[\w-]+$/.test(i))) return send(res, 400, { error: "Bad job ids." }), true;
      const sid = crypto.randomBytes(6).toString("hex");
      const q = renderSlot.stats ? renderSlot.stats() : null, ahead = q ? q.waiting + (q.active >= q.slots ? 1 : 0) : 0;
      const st = { status: "running", step: ahead ? `Waiting for ${ahead} other video${ahead > 1 ? "s" : ""} to finish rendering…` : "Starting…", warnings: [], createdAt: Date.now() };
      const nar = b.narration && Array.isArray(b.narration.lines) && b.narration.model ? b.narration : null;
      const lang = hing.isHinglish(req) ? "hinglish" : undefined;
      // budget mode: clips shorter than their narration are slowed down (up to 1.5x) and then hold their last
      // frame, instead of cutting the narration off
      const extend = !!b.extend;
      const dir = path.join(WORK, sid);
      fs.mkdirSync(dir, { recursive: true });
      stitches.set(sid, st);
      const hist = (rec) => { try { ctx.history && ctx.history.put("story-" + sid, { kind: "story", url: `/api/final/${sid}`, thumb: `/api/final/${sid}/thumb.jpg`, ...rec }); } catch {} };
      hist({ status: "running", title: String(b.title || "Story").slice(0, 140), duration: undefined, retry: { endpoint: "/api/stitch", body: { ...b } } });
      const step = (s) => { st.step = s; saveStatus(sid, st); };
      step(st.step);
      renderSlot(async () => {
        const [W, H] = b.aspect === "16:9" ? [1280, 720] : b.aspect === "1:1" ? [720, 720] : [720, 1280];
        const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,format=yuv420p`;
        const enc = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "aac", "-ar", "44100", "-ac", "2"];
        let list = "", t = 0;
        const starts = []; // where each scene starts in the final video (for sound effects on the cuts)
        for (let i = 0; i < ids.length; i++) {
          const line = nar ? String(nar.lines[i] || "").trim() : "";
          step(`Downloading clip ${i + 1}/${ids.length}`);
          const cached = path.join(WORK, "videos", ids[i] + ".mp4");
          if (!fs.existsSync(cached)) { // downloads once into the shared video cache (works for every provider)
            try { await ctx.ensureVideo(ids[i]); } catch (e) { throw new Error(`Clip ${i + 1} download failed (${e.status || e.message})`); }
          }
          fs.copyFileSync(cached, path.join(dir, `raw${i}.mp4`));
          step(`Preparing clip ${i + 1}/${ids.length}`);
          const audio = await hasAudio(path.join(dir, `raw${i}.mp4`));
          let args;
          if (line) {
            step(`Voicing scene ${i + 1}/${ids.length}`);
            fs.writeFileSync(path.join(dir, `nar${i}.mp3`), await tts({ model: nar.model, voice: nar.voice, text: line, instructions: nar.instructions, lang }));
            // the voice service adds silence before and after a line; trimmed, the lines flow from scene to scene
            try {
              await run(["-y", "-i", `nar${i}.mp3`, "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,adelay=60|60", "-c:a", "libmp3lame", "-q:a", "2", `nart${i}.mp3`], dir);
              if (await mediaDuration(path.join(dir, `nart${i}.mp3`)) > 0.3) fs.renameSync(path.join(dir, `nart${i}.mp3`), path.join(dir, `nar${i}.mp3`));
            } catch {}
            const vd = await mediaDuration(path.join(dir, `raw${i}.mp4`)), ad = await mediaDuration(path.join(dir, `nar${i}.mp3`));
            // The whole line is always heard: the scene is made long enough for it, never cut off. In order:
            // 1. the voice is sped up a touch (at most 1.12x, still sounds natural),
            // 2. the clip is slowed a little (at most 1.3x, 1.5x in budget mode),
            // 3. only then does the last frame hold for the rest.
            // Plus a short breath after the line so scenes don't run into each other.
            const plan = fitScene(vd, ad, extend);
            const D = plan.D, ds = D.toFixed(3);
            let v = "[0:v]";
            if (plan.slow > 1.001) v += `setpts=${plan.slow.toFixed(3)}*PTS,`;
            v += vf;
            if (plan.hold > 0.01) { // the last frame holds with a slow push-in, so it never looks frozen
              const t0 = (vd * plan.slow).toFixed(3), hd = Math.max(0.5, plan.hold).toFixed(3);
              v += `,tpad=stop_mode=clone:stop_duration=${(plan.hold + 0.1).toFixed(3)}` +
                `,zoompan=z='if(gt(it,${t0}),1+0.06*min(1,(it-${t0})/${hd}),1)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=24`;
            }
            v += "[v]";
            // every pad has a fixed length (an endless apad never stops on the server's older ffmpeg 5.1) and so does
            // the output (-t)
            const voice = `[1:a]${plan.tempo > 1.001 ? `atempo=${plan.tempo.toFixed(3)},` : ""}apad=whole_dur=${ds},atrim=0:${ds}`;
            // the clip's own sound is dropped under narration: video models often add talking of their own, which
            // came through as a second voice. Ambience, music and effects are laid back in by mixStory below.
            const fc = `${v};${voice}[a]`;
            args = ["-y", "-i", `raw${i}.mp4`, "-i", `nar${i}.mp3`, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", ds, ...enc, `n${i}.mp4`];
          } else {
            // a scene without narration keeps its own sound (quieter when the story is narrated)
            args = audio
              ? ["-y", "-i", `raw${i}.mp4`, "-vf", vf, ...(nar ? ["-af", "volume=0.6"] : []), ...enc, `n${i}.mp4`]
              : await (async () => { // silent clip: add a silent track exactly as long as the clip
                const vd = await mediaDuration(path.join(dir, `raw${i}.mp4`));
                return ["-y", "-i", `raw${i}.mp4`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-vf", vf, ...(vd ? ["-t", vd.toFixed(3)] : ["-shortest"]), ...enc, `n${i}.mp4`];
              })();
          }
          await run(args, dir);
          list += `file 'n${i}.mp4'\n`;
          starts.push(t); t += (await mediaDuration(path.join(dir, `n${i}.mp4`))) || 0;
        }
        step("Joining clips");
        fs.writeFileSync(path.join(dir, "list.txt"), list);
        if (b.look === "glitch") { // neon-glitch look over the whole video (needs one re-encode)
          await run(["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], dir);
          step("Adding the glitch look");
          const total = await mediaDuration(path.join(dir, "joined.mp4"));
          await run(["-y", "-i", "joined.mp4", "-filter_complex", glitchFilter("[0:v]", "[v]", W, H, total, total), "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], dir);
        } else await run(["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "final.mp4"], dir);
        // sound design: music + ambience under the whole story (dipping when the narrator speaks), effects on cuts
        const snd = b.sound && typeof b.sound === "object" ? b.sound : null;
        if (snd) {
          step("Adding music and sound");
          const cues = (Array.isArray(snd.sfx) ? snd.sfx : []).map((fx, i) => ({ fx: String(fx || ""), t: starts[i] })).filter((c) => c.fx && c.fx !== "none" && c.t != null);
          const total = await mediaDuration(path.join(dir, "final.mp4"));
          try {
            if (await mixStory(run, dir, { input: "final.mp4", output: "mixed.mp4", total, music: snd.music, ambience: snd.ambience, cues, hasVoice: !!nar || b.speech === true }))
              fs.renameSync(path.join(dir, "mixed.mp4"), path.join(dir, "final.mp4"));
          } catch (e) { st.warnings.push("Music and sound could not be added (" + e.message.slice(0, 120) + "). The video has the narration only."); }
        }
        // keep only what's needed to replay / re-stitch
        for (const f of fs.readdirSync(dir)) if (/^(n\d+\.mp4|joined\.mp4)$/.test(f)) fs.rm(path.join(dir, f), { force: true }, () => {});
        st.status = "completed"; st.step = "Done"; saveStatus(sid, st);
        const clipCost = ids.reduce((a, i) => a + (ctx.history?.get(i)?.cost || 0), 0);
        hist({ status: "completed", duration: Math.round(await mediaDuration(path.join(dir, "final.mp4"))), cost: clipCost || undefined });
      }).catch((e) => { st.status = "failed"; st.error = e.message.slice(-500); saveStatus(sid, st); hist({ status: "failed", error: st.error }); })
        .finally(() => setTimeout(() => stitches.delete(sid), 3600000));
      return send(res, 202, { id: sid }), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/stitch\/([a-f0-9]{12})$/))) {
      const st = readStatus(m[1]);
      // "running" on disk but not in memory: the server restarted mid-stitch, so it will never finish on its own
      if (st && st.status === "running" && !stitches.has(m[1])) return send(res, 200, { ...st, status: "interrupted", step: "The server restarted", url: null }), true;
      return (st ? send(res, 200, { ...st, url: st.status === "completed" ? `/api/final/${m[1]}` : null }) : send(res, 404, { error: "Unknown stitch" })), true;
    }
    if ((req.method === "GET" || req.method === "HEAD") && (m = url.pathname.match(/^\/api\/final\/(\w+)$/))) {
      return serveMp4(req, res, path.join(WORK, m[1], "final.mp4"), url.searchParams.has("download") ? "story.mp4" : false), true;
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/final\/(\w+)\/thumb\.jpg$/))) {
      return ctx.serveThumb(res, path.join(WORK, m[1], "final.mp4"), path.join(WORK, m[1], "thumb.jpg")), true;
    }

    // ---- finished stitched videos still on disk ----
    if (req.method === "GET" && url.pathname === "/api/finals") {
      const out = [];
      for (const d of fs.existsSync(WORK) ? fs.readdirSync(WORK) : []) {
        const f = path.join(WORK, d, "final.mp4");
        if (!/^\w+$/.test(d) || !fs.existsSync(f)) continue;
        const files = fs.readdirSync(path.join(WORK, d));
        out.push({ id: d, ts: fs.statSync(f).mtimeMs, size: fs.statSync(f).size, clips: files.filter((x) => /^raw\d+\.mp4$/.test(x)).length, narrated: files.some((x) => /^nar\d+\.mp3$/.test(x)), url: `/api/final/${d}` });
      }
      return send(res, 200, { finals: out.sort((a, b) => b.ts - a.ts) }), true;
    }

    // ---- story history ----
    if (req.method === "GET" && url.pathname === "/api/stories") return send(res, 200, { stories: readStories() }), true;
    if ((m = url.pathname.match(/^\/api\/stories\/(p[a-z0-9]{4,20})$/))) {
      if (req.method === "PUT") {
        const b = await readBody(req, 2e6);
        if (!b || !Array.isArray(b.scenes)) return send(res, 400, { error: "Bad story." }), true;
        const all = readStories().filter((x) => x.id !== m[1]);
        all.unshift({ ...b, id: m[1], ts: Date.now() });
        writeStories(all);
        return send(res, 200, { ok: true }), true;
      }
      if (req.method === "DELETE") { writeStories(readStories().filter((x) => x.id !== m[1])); return send(res, 200, { ok: true }), true; }
    }
    return false;
  } };
};

module.exports.fitScene = fitScene;
