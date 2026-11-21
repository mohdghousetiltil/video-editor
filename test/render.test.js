// Render tests: the ffmpeg filter chains actually run (needs ffmpeg on PATH; skipped otherwise).
// They use tiny synthetic clips, so they take a few seconds and cost nothing.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { glitchFilter } = require("../glitch");

const FF = process.env.FFMPEG_PATH || "ffmpeg";
const hasFF = spawnSync(FF, ["-version"]).status === 0;
const ff = (args, cwd) => { const r = spawnSync(FF, ["-hide_banner", "-loglevel", "error", "-y", ...args], { cwd, encoding: "utf8" }); if (r.status !== 0) throw new Error(r.stderr.slice(-500)); };
const dur = (f) => { const r = spawnSync(FF, ["-hide_banner", "-i", f], { encoding: "utf8" }); const m = r.stderr.match(/Duration: (\d+):(\d+):([\d.]+)/); return m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : 0; };

test("render: glitch look, jump-cut concat with zoom, and narration mix", { skip: !hasFF && "ffmpeg not installed" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-render-"));
  try {
    ff(["-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=8", "-f", "lavfi", "-i", "sine=f=440:d=8", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "src.mp4"], dir);
    // the neon glitch look
    ff(["-i", "src.mp4", "-filter_complex", glitchFilter("[0:v]", "[v]", 640, 360, 8, 1), "-map", "[v]", "-map", "0:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "copy", "glitch.mp4"], dir);
    assert.ok(Math.abs(dur(path.join(dir, "glitch.mp4")) - 8) < 0.3);
    // two pieces, the second zoomed (both must end up 1080x1920 SAR 1:1 or concat fails)
    const fc = "[0:v]fps=30,split=2[s0][s1];" +
      "[s0]trim=0:3,setpts=PTS-STARTPTS,scale=3414:1920,crop=1080:1920:1167:0,setsar=1[v0];" +
      "[s1]trim=5:8,setpts=PTS-STARTPTS,scale=3414:1920,crop=1080:1920:1167:0,setsar=1,scale=1210:2150,crop=1080:1920,setsar=1[v1];" +
      "[v0][v1]concat=n=2:v=1:a=0[vc];[0:a]asplit=2[a0][a1];[a0]atrim=0:3,asetpts=PTS-STARTPTS[x0];[a1]atrim=5:8,asetpts=PTS-STARTPTS[x1];[x0][x1]concat=n=2:v=0:a=1[ac]";
    ff(["-i", "src.mp4", "-filter_complex", fc, "-map", "[vc]", "-map", "[ac]", "-c:v", "libx264", "-preset", "ultrafast", "cut.mp4"], dir);
    assert.ok(Math.abs(dur(path.join(dir, "cut.mp4")) - 6) < 0.3, "3 s + 3 s");
    // narrator over ducked original sound
    ff(["-f", "lavfi", "-i", "sine=f=900:d=2", "vo.mp3"], dir);
    ff(["-i", "cut.mp4", "-i", "vo.mp3", "-filter_complex", "[0:a]volume='if(between(t,0.5,2.7),0.22,1)':eval=frame[o];[1:a]adelay=500|500[n];[o][n]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14[a]",
      "-map", "0:v", "-map", "[a]", "-c:v", "copy", "final.mp4"], dir);
    assert.ok(dur(path.join(dir, "final.mp4")) > 5.5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
