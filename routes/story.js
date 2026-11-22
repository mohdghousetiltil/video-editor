// Story mode routes: plan a script into scenes, lock the cast (character sheet + per-scene first frames), voice,
// stitch clips into one video, and keep story history on the server.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

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
      const total = Number(b.total) || 30, model = settings.get().textModel;
      const sys = "You are a video director planning a short video for an AI text-to-video model. Split the user's script into scenes. " +
        `Total length about ${total} seconds; each scene 3 to 5 seconds (integers; short shots look better on Reels and Shorts and hide the drift of faces and hands that long AI clips show; use several shots for one narration beat) and the seconds must add up to about ${total}. ` +
        "Set continues:true on a scene only when it directly continues the previous scene in the same place with the same characters and uninterrupted action (so it can start from the previous scene's last frame); set continues:false for the first scene and for any cut to a new location or time. Mark scenes as key:true ONLY for the roughly 30% that matter most visually (the hook, the big reveal, the twist, the emotional peak); the rest are key:false filler/transition scenes. " +
        "Write a 'bible': for EACH recurring character one sentence with name, age, build, face, hair, and exact clothing with colors, plus one sentence for the main setting, so every scene stays consistent. " +
        "Each scene prompt must be self-contained, one vivid present-tense sentence or two, describing only visible action, camera and mood, naming characters by their bible appearance. No on-screen text. For every scene also write \"narration\": the voiceover a calm narrator speaks during that scene, natural spoken language, at most 2.3 words per second of the scene length, so the narration of all scenes reads as one continuous story (use an empty string only for a deliberately silent scene). " +
        `Aspect ratio ${b.aspect || "9:16"}. ` + (b.style ? "Visual style: " + b.style + " " : "") +
        'Reply with ONLY valid JSON, no markdown: {"bible":"...","scenes":[{"title":"...","prompt":"...","seconds":6,"key":true,"continues":false,"narration":"..."}]}';
      const r = await orFetch(`${API}/chat/completions`, {
        method: "POST", headers: orHeaders(),
        body: JSON.stringify({ model, max_tokens: 4000, reasoning: { enabled: false }, messages: [{ role: "system", content: sys }, { role: "user", content: b.script.trim() }] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return send(res, r.status, { error: j.error?.message || "Planning failed" }), true;
      spend.log("Story", j.usage?.cost, model);
      const txt = j.choices?.[0]?.message?.content || "";
      try {
        const plan = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
        if (!Array.isArray(plan.scenes) || !plan.scenes.length) throw new Error("no scenes");
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
        const buf = await tts({ model: b.model, voice: b.voice, text: String(b.text).slice(0, 600), instructions: b.instructions });
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
        let list = "";
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
            fs.writeFileSync(path.join(dir, `nar${i}.mp3`), await tts({ model: nar.model, voice: nar.voice, text: line, instructions: nar.instructions }));
            const vd = await mediaDuration(path.join(dir, `raw${i}.mp4`)), ad = await mediaDuration(path.join(dir, `nar${i}.mp3`));
            if (extend) {
              const D = Math.max(vd, ad + 0.4), slow = vd ? Math.max(1, Math.min(1.5, D / vd)) : 1;
              const v = `[0:v]setpts=${slow.toFixed(3)}*PTS,${vf},tpad=stop_mode=clone:stop_duration=${Math.max(0, D - vd * slow + 0.1).toFixed(3)}[v]`;
              // padding always has a fixed length: an endless apad never stops on the server's older ffmpeg
              const pd = `apad=whole_dur=${D.toFixed(3)}`;
              const fc = audio ? `${v};[0:a]volume=0.25,${pd}[a0];[1:a]${pd}[a1];[a0][a1]amix=inputs=2:duration=longest:dropout_transition=0[a]` : `${v};[1:a]${pd}[a]`;
              args = ["-y", "-i", `raw${i}.mp4`, "-i", `nar${i}.mp3`, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", "-t", D.toFixed(3), ...enc, `n${i}.mp4`];
            } else {
              const tempo = vd && ad ? Math.max(1, Math.min(1.35, (ad / vd) * 0.98)) : 1;
              if (vd && ad / tempo > vd + 0.2) st.warnings.push(`Scene ${i + 1}: narration is longer than the clip and was cut off. Shorten the text.`);
              // the scene lasts exactly as long as its clip: narration padded / trimmed to that length and an explicit
              // -t. "apad + -shortest" alone never ended on the server's ffmpeg 5.1 and hung the whole stitch.
              const len = vd ? ["-t", vd.toFixed(3)] : ["-shortest"];
              const a1 = `[1:a]atempo=${tempo.toFixed(3)},${vd ? `apad=whole_dur=${vd.toFixed(3)},atrim=0:${vd.toFixed(3)}` : "apad"}[a1]`;
              const fc = audio
                ? `[0:v]${vf}[v];[0:a]volume=0.25[a0];${a1};[a0][a1]amix=inputs=2:duration=first:dropout_transition=0[a]`
                : `[0:v]${vf}[v];${a1.replace("[a1]", "[a]")}`;
              args = ["-y", "-i", `raw${i}.mp4`, "-i", `nar${i}.mp3`, "-filter_complex", fc, "-map", "[v]", "-map", "[a]", ...len, ...enc, `n${i}.mp4`];
            }
          } else {
            args = audio
              ? ["-y", "-i", `raw${i}.mp4`, "-vf", vf, ...enc, `n${i}.mp4`]
              : await (async () => { // silent clip: add a silent track exactly as long as the clip
                const vd = await mediaDuration(path.join(dir, `raw${i}.mp4`));
                return ["-y", "-i", `raw${i}.mp4`, "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-vf", vf, ...(vd ? ["-t", vd.toFixed(3)] : ["-shortest"]), ...enc, `n${i}.mp4`];
              })();
          }
          await run(args, dir);
          list += `file 'n${i}.mp4'\n`;
        }
        step("Joining clips");
        fs.writeFileSync(path.join(dir, "list.txt"), list);
        if (b.look === "glitch") { // neon-glitch look over the whole video (needs one re-encode)
          await run(["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "joined.mp4"], dir);
          step("Adding the glitch look");
          const total = await mediaDuration(path.join(dir, "joined.mp4"));
          await run(["-y", "-i", "joined.mp4", "-filter_complex", glitchFilter("[0:v]", "[v]", W, H, total, total), "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-c:a", "copy", "-movflags", "+faststart", "final.mp4"], dir);
        } else await run(["-y", "-f", "concat", "-safe", "0", "-i", "list.txt", "-c", "copy", "-movflags", "+faststart", "final.mp4"], dir);
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
