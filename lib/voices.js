// Narrator voices (OpenRouter /audio/speech), shared by Shorts and the influencer's own voice. Ids are the ones each
// speech model lists as supported. Kokoro costs ~$0.002 a minute; ElevenLabs sounds more natural.
const KOKORO = "hexgrad/kokoro-82m", ELEVEN = "elevenlabs/eleven-turbo-v2.5";
const cap = (x) => x[0].toUpperCase() + x.slice(1);
const kokoro = (kind, ids) => ids.split(" ").map((id) => ({ voice: id, model: KOKORO, label: `${cap(id.slice(3))} (${kind}, Kokoro)` }));
const eleven = (kind, ids) => ids.split(" ").map((id) => ({ voice: id, model: ELEVEN, label: `${cap(id)} (${kind}, ElevenLabs)` }));
// Michael stays first: it is the default
const VOICES = [
  ...kokoro("US male", "am_michael am_adam am_echo am_eric am_fenrir am_liam am_onyx am_puck am_santa"),
  ...kokoro("US female", "af_heart af_bella af_alloy af_aoede af_jessica af_kore af_nicole af_nova af_river af_sarah af_sky"),
  ...kokoro("UK male", "bm_george bm_daniel bm_fable bm_lewis"),
  ...kokoro("UK female", "bf_emma bf_alice bf_isabella bf_lily"),
  ...kokoro("Hindi female", "hf_alpha hf_beta"),
  ...kokoro("Hindi male", "hm_omega hm_psi"),
  ...eleven("male", "brian adam bill callum charlie chris daniel eric george harry liam roger will"),
  ...eleven("female", "jessica alice bella laura lily matilda sarah"),
  ...eleven("neutral", "river"),
];
module.exports = { VOICES };
