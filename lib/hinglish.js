// Hinglish mode: everything the AI writes or says is modern Hinglish (Hindi and English mixed the way young urban
// Indians talk), written ONLY in English (Roman) letters. Devanagari is banned everywhere: the AI is told, and anything
// that still comes back in Devanagari is turned into Roman letters here before it is shown, spoken or captioned.
// The mode is switched on by a hidden gesture in the app; every request then carries the header "X-Lang: hinglish".

const isHinglish = (req) => String((req && req.headers && req.headers["x-lang"]) || "").toLowerCase() === "hinglish";

// put in front of every instruction that makes text people read or hear
const RULE =
  "LANGUAGE: write everything people will read or hear (replies, scripts, narration, dialogue, voiceover, captions, titles, descriptions) in modern Hinglish: " +
  "Hindi and English mixed naturally, exactly how young urban Indians talk and text, for example 'Bhai, plan toh ekdum perfect tha, par phir ek twist aa gaya.' " +
  "Write it ONLY in English (Roman) letters. NEVER use Devanagari or any other non-Latin script, not even a single word. " +
  "Use everyday English words wherever people really use them (phone, video, plan, problem, time, scene, twist, idea, share, simple) and simple spoken Hindi for the rest. " +
  "No formal, bookish or Sanskrit-style Hindi (never words like chalchitra, upyog, atyant, prastut, dhanyavaad; say photo not tasveer, video not chalchitra, time not samay, idea not vichaar). Keep it short, punchy and natural to say aloud. " +
  "Anything that is not meant to be read or heard (JSON keys, field names, visual scene descriptions for the video model) stays in plain English.";

// added to video prompts: what the people IN a clip say
const SPEECH_RULE =
  " Spoken language: every line a person says in this clip is in Hinglish (modern Hindi mixed with English, said the way young urban Indians talk), " +
  "with a natural Indian accent. Any text that appears on screen is in English letters only, never Devanagari.";

// models that can speak Hindi / Hinglish inside a clip (Google's Veo and Gemini Omni). The others (Seedance, Kling, Wan, Grok...)
// do not handle Hindi speech, so in Hinglish mode they are switched off wherever the clip itself has to talk.
const hindiSpeech = (id) => /^google\//.test(String(id || ""));

// voices: Hinglish needs a multilingual voice. ElevenLabs v3 reads Roman-letter Hinglish well; the cheap Kokoro voices are English-only.
const HINGLISH_TTS = "elevenlabs/eleven-v3";
const TONE = "Speak natural, conversational Hinglish: Hindi and English mixed, with a clear Indian accent, the way a young person in India tells a story.";
function hingVoice({ model, voice, instructions }) {
  const female = /^[abh]f_|^(sarah|jessica|alice|bella|lily|matilda|laura|aria)$/i.test(String(voice || ""));
  const keep = /eleven/.test(String(model || "")) && voice && !/^[abhi][fm]_/.test(voice);
  return { model: HINGLISH_TTS, voice: keep ? voice : female ? "jessica" : "brian", instructions: [instructions, TONE].filter(Boolean).join(" ") };
}

// ---- Devanagari -> Roman letters (a last resort, so the ban holds even when a model slips) ----
const DEVA = /[ऀ-ॿ]/;
const V = { "अ": "a", "आ": "aa", "इ": "i", "ई": "ee", "उ": "u", "ऊ": "oo", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o", "ऍ": "e" };
const M = { "ा": "aa", "ि": "i", "ी": "ee", "ु": "u", "ू": "oo", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e" };
const C = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "ng", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh", "ष": "sh", "स": "s", "ह": "h",
  "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "r", "ढ़": "rh", "फ़": "f", "य़": "y",
};
const DIGITS = "०१२३४५६७८९";
function devanagariToRoman(text) {
  const s = String(text).normalize("NFC").replace(/([कखगजडढफय])़/g, "$1़");
  let out = "";
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    // consonant + nukta is one letter
    if (chars[i + 1] === "़" && C[ch + "़"]) { ch += "़"; i++; }
    if (C[ch]) {
      out += C[ch];
      const nx = chars[i + 1];
      if (nx === "्") { i++; continue; } // halant: no vowel
      if (nx && M[nx]) { out += M[nx]; i++; continue; }
      // inherent "a": dropped at the end of a word (kamal, not kamala)
      const after = chars[i + 1];
      const wordEnd = !after || !/[ऀ-ॿ]/.test(after) || after === "ं" || after === "ः" || after === "ँ";
      if (!wordEnd) out += "a";
      continue;
    }
    if (V[ch]) { out += V[ch]; continue; }
    if (ch === "ं" || ch === "ँ") { out += "n"; continue; } // anusvara, chandrabindu
    if (ch === "ः") { out += "h"; continue; } // visarga
    if (ch === "़" || ch === "्") continue;
    if (ch === "।" || ch === "॥") { out += "."; continue; }
    const d = DIGITS.indexOf(ch);
    if (d >= 0) { out += String(d); continue; }
    out += ch;
  }
  return out;
}
const hasDevanagari = (s) => DEVA.test(String(s));
const scrub = (s) => (typeof s === "string" && hasDevanagari(s) ? devanagariToRoman(s) : s);
// every string inside an object / array (JSON from a model)
function scrubDeep(v) {
  if (typeof v === "string") return scrub(v);
  if (Array.isArray(v)) return v.map(scrubDeep);
  if (v && typeof v === "object") { const o = {}; for (const k of Object.keys(v)) o[k] = scrubDeep(v[k]); return o; }
  return v;
}

module.exports = { isHinglish, RULE, SPEECH_RULE, hindiSpeech, hingVoice, HINGLISH_TTS, TONE, devanagariToRoman, hasDevanagari, scrub, scrubDeep };
