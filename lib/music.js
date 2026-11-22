// Background music made right here from maths (ffmpeg aevalsrc), so there are never any rights issues.
// Used by Shorts and by "Add music" on a finished Single clip.
const path = require("path");

// b = position inside a beat of length L seconds; tones decay from each beat
const beat = (L) => `mod(t,${L})`;
// a tone with a slightly detuned twin: a richer, string-like sound
const str = (f, a) => `${a}*(sin(2*PI*${f}*t)+0.7*sin(2*PI*${(f * 1.004).toFixed(3)}*t))`;
// slow cinematic chords (Am, F, C, G, 4 s each), every chord swelling in and out
const chord = (fs) => fs.map((f, i) => str(f, i === 0 ? 0.09 : 0.06)).join("+");
const PROG = [[110, 220, 261.63, 329.63], [87.31, 174.61, 220, 261.63], [130.81, 261.63, 329.63, 392], [98, 196, 246.94, 293.66]];
const cinematicPad = PROG.map((c, k) => `(${chord(c)})*if(eq(floor(mod(t,16)/4),${k}),1,0)`).join("+");

const MOOD_EXPR = {
  // 120 bpm: kick on every beat, off-beat hats, a bass line that moves every 2 bars
  upbeat: `0.55*sin(2*PI*(45+90*exp(-25*${beat(0.5)}))*${beat(0.5)})*exp(-7*${beat(0.5)})` +
    `+0.05*(random(1)-0.5)*exp(-60*mod(t+0.25,0.5))` +
    `+0.16*sin(2*PI*110*if(lt(mod(t,4),2),1,if(lt(mod(t,4),3),1.335,1.189))*t)*(0.55+0.45*exp(-6*${beat(0.25)}))`,
  // low drone, slow pulse, a soft clock tick: tension that builds
  suspense: `(0.22*sin(2*PI*55*t)+0.12*sin(2*PI*82.41*t)+0.05*sin(2*PI*233.08*t))*(0.6+0.4*sin(2*PI*0.5*t))` +
    `+0.12*sin(2*PI*1400*t)*exp(-90*${beat(0.5)})`,
  // film-trailer feel: swelling string chords, deep drum hits every 2 s, everything rising over the first 8 s
  cinematic: `min(1,0.35+t/12)*((${cinematicPad})*(0.55-0.45*cos(2*PI*mod(t,4)/4))` +
    `+0.65*sin(2*PI*(32+48*exp(-9*${beat(2)}))*${beat(2)})*exp(-2.6*${beat(2)})` +
    `+0.25*sin(2*PI*(45+60*exp(-14*mod(t+1,2)))*mod(t+1,2))*exp(-5*mod(t+1,2))*gte(t,8))`,
  // warm chords that change every 4 s, gently breathing
  chill: `(0.15*sin(2*PI*220*t)+0.11*sin(2*PI*277.18*t)+0.1*sin(2*PI*329.63*t)+0.07*sin(2*PI*110*t))*if(lt(mod(t,8),4),1,0)` +
    `+(0.15*sin(2*PI*196*t)+0.11*sin(2*PI*246.94*t)+0.1*sin(2*PI*293.66*t)+0.07*sin(2*PI*98*t))*if(lt(mod(t,8),4),0,1)`,
  // big slow drums and a power chord
  epic: `0.7*sin(2*PI*(40+60*exp(-18*${beat(1)}))*${beat(1)})*exp(-4*${beat(1)})` +
    `+(0.12*sin(2*PI*73.42*t)+0.1*sin(2*PI*110*t)+0.08*sin(2*PI*146.83*t))*(0.7+0.3*sin(2*PI*0.25*t))`,
  // bouncy plucks, like a cartoon
  funny: `0.22*sin(2*PI*if(lt(mod(t,1),0.5),392,if(lt(mod(t,1),0.75),523.25,440))*t)*exp(-9*${beat(0.25)})` +
    `+0.3*sin(2*PI*(60+60*exp(-30*${beat(0.5)}))*${beat(0.5)})*exp(-10*${beat(0.5)})`,
};
const MOODS = Object.keys(MOOD_EXPR);
// per mood: tone (lowpass) and room (echo); cinematic gets a big hall
const FX = {
  upbeat: "lowpass=f=5000,aecho=0.8:0.6:50:0.25", funny: "lowpass=f=5000,aecho=0.8:0.6:50:0.25",
  cinematic: "lowpass=f=2600,aecho=0.8:0.7:120|260:0.35|0.22",
};

// renders mood m (len seconds) into dir and returns the file path
async function renderMood(run, m, dir, len) {
  if (m === "pad") m = "chill";
  if (!MOOD_EXPR[m]) return null;
  const f = path.join(dir, `music-${m}.m4a`);
  await run(["-y", "-f", "lavfi", "-i", `aevalsrc='${MOOD_EXPR[m]}':s=48000:d=${Math.ceil(len + 1)}`, "-af", `${FX[m] || "lowpass=f=1800,aecho=0.8:0.6:50:0.25"},alimiter=limit=0.8`, "-ac", "2", "-c:a", "aac", "-b:a", "128k", path.basename(f)], dir);
  return f;
}

module.exports = { MOOD_EXPR, MOODS, renderMood };
