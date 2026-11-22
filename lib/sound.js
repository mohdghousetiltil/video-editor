// Sound design for Story mode, made right here from noise and maths (ffmpeg), so there are no rights issues and
// nothing to download: ambience beds under the whole story, short effects on key moments, and the final mix where
// music and ambience dip under the narration.
const path = require("path");
const { MOODS, renderMood } = require("./music");

// ambience: a quiet bed of place sound (lavfi source + filters). Every source has a fixed length (d=...).
const AMBIENCE = {
  night: (d) => [`anoisesrc=c=pink:a=0.12:d=${d}`, `lowpass=f=900,volume=0.5`,
    // crickets: a fast chirp, in bursts
    `aevalsrc='0.05*sin(2*PI*4600*t)*gt(sin(2*PI*28*t),0)*gt(sin(2*PI*0.9*t),0.2)':s=48000:d=${d}`],
  rain: (d) => [`anoisesrc=c=white:a=0.35:d=${d}`, `highpass=f=900,lowpass=f=7000,volume=0.45`],
  wind: (d) => [`anoisesrc=c=brown:a=0.6:d=${d}`, `bandpass=f=420:width_type=o:w=2,tremolo=f=0.13:d=0.7,volume=0.9`],
  room: (d) => [`anoisesrc=c=brown:a=0.25:d=${d}`, `lowpass=f=220,volume=0.7`],
  city: (d) => [`anoisesrc=c=brown:a=0.45:d=${d}`, `bandpass=f=300:width_type=o:w=3,tremolo=f=0.1:d=0.4,volume=0.8`],
  ocean: (d) => [`anoisesrc=c=pink:a=0.5:d=${d}`, `lowpass=f=1300,tremolo=f=0.11:d=0.9,volume=0.7`],
  fire: (d) => [`anoisesrc=c=brown:a=0.3:d=${d}`, `lowpass=f=500,volume=0.6`,
    // crackles: rare random clicks
    `aevalsrc='0.5*(random(0)-0.5)*gt(random(1),0.9985)':s=48000:d=${d}`],
  drone: (d) => [`aevalsrc='(0.25*sin(2*PI*41.2*t)+0.15*sin(2*PI*61.7*t)+0.06*sin(2*PI*123.5*t))*(0.75+0.25*sin(2*PI*0.08*t))':s=48000:d=${d}`, `lowpass=f=400`],
};
const AMBIENCES = Object.keys(AMBIENCE);

// effects: [lavfi source, filters, length s, where it sits: 0 = starts on the cut, 1 = ends on the cut (a build-up)]
const SFX = {
  whoosh: [`anoisesrc=c=pink:a=0.9:d=1.2`, `bandpass=f=1400:width_type=o:w=2,afade=t=in:d=0.7,afade=t=out:st=0.7:d=0.5`, 1.2, 0.5],
  impact: [`aevalsrc='0.9*sin(2*PI*(38+90*exp(-14*t))*t)*exp(-2.6*t)+0.25*(random(0)-0.5)*exp(-18*t)':s=48000:d=2.5`, `lowpass=f=1800`, 2.5, 0],
  heartbeat: [`aevalsrc='0.9*sin(2*PI*52*t)*(exp(-28*mod(t,0.95))+0.7*exp(-28*mod(t-0.22,0.95))*gte(t,0.22))':s=48000:d=3.8`, `lowpass=f=160`, 3.8, 0],
  thunder: [`anoisesrc=c=brown:a=1:d=4.5`, `lowpass=f=280,afade=t=in:d=0.08,afade=t=out:st=0.6:d=3.9,volume=1.6`, 4.5, 0],
  riser: [`aevalsrc='0.35*sin(2*PI*(110+700*(t/3)^2)*t)*(t/3)+0.15*(random(0)-0.5)*(t/3)^2':s=48000:d=3`, `lowpass=f=5000`, 3, 1],
  glitch: [`aevalsrc='0.4*sgn(sin(2*PI*(200+1800*random(1))*t))*gt(sin(2*PI*9*t),0.3)':s=48000:d=0.7`, `highpass=f=300,lowpass=f=6000`, 0.7, 0],
  knock: [`aevalsrc='0.9*sin(2*PI*140*t)*(exp(-40*t)+exp(-40*(t-0.32))*gte(t,0.32)+exp(-40*(t-0.64))*gte(t,0.64))':s=48000:d=1.2`, `lowpass=f=900`, 1.2, 0],
  creak: [`aevalsrc='0.3*sin(2*PI*(160+40*sin(2*PI*1.3*t))*t)*sgn(sin(2*PI*31*t))*(1-t/1.8)':s=48000:d=1.8`, `bandpass=f=700:width_type=o:w=2`, 1.8, 0],
};
const EFFECTS = Object.keys(SFX);

// one fixed-length ambience bed for the whole video
async function renderAmbience(run, kind, dir, len) {
  const mk = AMBIENCE[kind];
  if (!mk) return null;
  const d = Math.ceil(len + 1), [src, fx, extra] = mk(d), f = `amb-${kind}.m4a`;
  const args = ["-y", "-f", "lavfi", "-i", src];
  let fc = `[0:a]${fx}[b]`;
  if (extra) { args.push("-f", "lavfi", "-i", extra); fc += `;[b][1:a]amix=inputs=2:duration=first:dropout_transition=0[b2]`; }
  await run([...args, "-filter_complex", fc + (extra ? ";[b2]" : ";[b]") + `aformat=sample_rates=48000:channel_layouts=stereo,atrim=0:${d},alimiter=limit=0.8[o]`, "-map", "[o]", "-c:a", "aac", "-b:a", "128k", f], dir);
  return path.join(dir, f);
}

// Mix the story: narration (the video's own track) on top; music and ambience under it, dipping whenever the
// narrator speaks; effects at scene cuts. cues = [{t: seconds, fx: "impact"}]. Writes out (video stream copied).
async function mixStory(run, dir, { input, output, total, music, ambience, cues = [], hasVoice = true }) {
  const args = ["-y", "-i", input], beds = [];
  const mf = MOODS.includes(music) ? await renderMood(run, music, dir, total) : null;
  const af = AMBIENCES.includes(ambience) ? await renderAmbience(run, ambience, dir, total) : null;
  const T = total.toFixed(3), fo = Math.max(0, total - 2).toFixed(3);
  if (mf) { args.push("-i", mf); beds.push(`[${beds.length + 1}:a]volume=0.5,afade=t=in:d=1.5,afade=t=out:st=${fo}:d=2[m]`); }
  if (af) { args.push("-i", af); beds.push(`[${beds.length + 1}:a]volume=0.55,afade=t=in:d=1,afade=t=out:st=${fo}:d=2[amb]`); }
  const fx = cues.filter((c) => SFX[c.fx] && c.t >= 0 && c.t < total).slice(0, 24);
  if (!beds.length && !fx.length) return false;
  let n = beds.length + 1;
  const parts = [`[0:a]aformat=sample_rates=48000:channel_layouts=stereo,apad=whole_dur=${T},atrim=0:${T}[v0]`, ...beds];
  const fxLabels = [];
  for (const c of fx) {
    const [src, filt, len, endsOnCut] = SFX[c.fx];
    args.push("-f", "lavfi", "-i", src);
    const at = Math.max(0, c.t - (endsOnCut ? len * endsOnCut : 0));
    parts.push(`[${n}:a]${filt},aformat=sample_rates=48000:channel_layouts=stereo,volume=0.7,adelay=${Math.round(at * 1000)}:all=1[x${n}]`);
    fxLabels.push(`[x${n}]`); n++;
  }
  // bed = music + ambience, ducked under the voice (sidechain from the narration track)
  const bedIn = [mf && "[m]", af && "[amb]"].filter(Boolean);
  let mixIn = ["[v1]"];
  parts.push(`[v0]asplit=2[v1][key]`);
  if (bedIn.length) {
    parts.push(`${bedIn.join("")}amix=inputs=${bedIn.length}:duration=longest:dropout_transition=0:normalize=0[bed]`);
    if (hasVoice) { parts.push(`[bed][key]sidechaincompress=threshold=0.02:ratio=10:attack=15:release=450:makeup=1[duck]`); mixIn.push("[duck]"); }
    else { parts.push("[key]anullsink"); mixIn.push("[bed]"); }
  } else parts.push("[key]anullsink");
  if (fxLabels.length) { parts.push(`${fxLabels.join("")}amix=inputs=${fxLabels.length}:duration=longest:dropout_transition=0:normalize=0[sfx]`); mixIn.push("[sfx]"); }
  parts.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=first:dropout_transition=0:normalize=0,atrim=0:${T},alimiter=limit=0.95[a]`);
  await run([...args, "-filter_complex", parts.join(";"), "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", T, "-movflags", "+faststart", output], dir);
  return true;
}

module.exports = { AMBIENCES, EFFECTS, renderAmbience, mixStory, SFX, AMBIENCE };
