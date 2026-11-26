// Prompts for making new pictures of the SAME person from reference pictures: the body profiles ("poses"), the
// Realistic look and the Shorts cameo. Identity comes first: the reference is the source of truth, nothing is beautified, redesigned or invented.
// Written gender-neutral, and they keep the reference's medium: a photo stays an authentic photo, a 3D / anime / illustrated
// character stays in exactly that style (the identity rules apply to both).

// Who the subject is and what must not change.
const IDENTITY = [
  "You are an expert character-reconstruction and photography system.",
  "Your task: study the reference image (image 1) and create one new picture of THE EXACT SAME PERSON from the requested camera angle.",
  "PRIMARY OBJECTIVE: IDENTITY PRESERVATION. The reference defines who this person is and is the absolute source of truth. Preserve exactly:",
  "their facial identity and facial geometry; eye shape, eye spacing, eyebrows, nose, lips and jawline; skin tone, complexion and natural skin characteristics;",
  "hair colour, texture, length, density and hairstyle; body proportions, physique and natural anatomy; and every distinctive identifying detail.",
  "Separate the person's permanent features from temporary photographic ones (lighting, lens distortion, shadows, pose, perspective): keep the first, not the second.",
  "Do not beautify, redesign, idealise, reinterpret or make a lookalike: the result must be the same individual, not someone who resembles them.",
  "Where a feature is not visible in the reference, continue it with plain anatomical common sense from what is visible; never invent distinctive identifying features.",
].join(" ");

// Work out what the reference actually shows before drawing a new angle (selfies, mirror shots, sitting, side-on, partly hidden).
const ADAPTIVE = [
  "ADAPTIVE REFERENCE ANALYSIS. Before creating the picture, work out internally: which parts of the person are clearly visible; the original camera angle;",
  "the person's body orientation; which characteristics can be reliably identified; which are partly or fully hidden; and what can reasonably be reconstructed from the visible evidence.",
  "Do not copy the reference's composition: the requested camera angle takes priority over the reference's angle.",
  "A close-up selfie: keep the identity but use natural proportions, not the selfie lens distortion. A mirror selfie: reproduce the actual person, not the reflected room.",
  "A sitting photo: do not keep the sitting pose when a standing shot is requested. A side-on photo: read the facial geometry correctly before drawing other views.",
  "A partly hidden person: do not make up distinctive details for the hidden parts.",
].join(" ");

// How it must look: an authentic photograph for a photo, the same style for a drawn or 3D character.
const REALISM = [
  "MEDIUM: match the reference. If it is a photograph, the result must look like an authentic photograph taken by a professional photographer, not an AI render:",
  "realistic anatomy, natural skin texture with pores, believable proportions, real hair strands, accurate perspective, natural shadows and consistent lighting;",
  "no skin smoothing, plastic look, exaggerated curves, distorted anatomy, extra or missing limbs, artificial facial features or CGI look.",
  "If the reference is 3D, anime, cartoon or illustrated, keep exactly that style, with the same identity rules.",
].join(" ");

// The six poses: the camera angle and framing for each (they become the influencer's character sheet).
const VIEW_SHOT = {
  front:
    "REQUESTED VIEW: front portrait, head and upper chest. The person faces the camera straight on and looks into the lens, both ears equally visible, " +
    "neutral relaxed expression, natural upright posture. Preserve the exact facial identity, hairline and hairstyle.",
  left:
    "REQUESTED VIEW: a genuine 90-degree side profile facing screen-LEFT (the nose points to the left edge of the picture), head and shoulders. " +
    "Natural upright posture, the whole head rotated exactly 90 degrees from the camera: the visible eye, nose bridge, nose tip, lips, chin and jawline form a natural, " +
    "anatomically accurate side silhouette. Preserve the exact forehead shape, nose structure, lips, chin projection, hairstyle, hairline, skin tone and neck proportions. " +
    "A true side view, NOT a three-quarter angle; the person looks ahead, not at the camera. Do not change the facial structure.",
  right:
    "REQUESTED VIEW: a genuine 90-degree side profile facing screen-RIGHT (the nose points to the right edge of the picture), head and shoulders. " +
    "Natural upright posture, the whole head rotated exactly 90 degrees from the camera: the visible eye, nose bridge, nose tip, lips, chin and jawline form a natural, " +
    "anatomically accurate side silhouette. Preserve the exact forehead shape, nose structure, lips, chin projection, hairstyle, hairline, skin tone and neck proportions. " +
    "A true side view, NOT a three-quarter angle; the person looks ahead, not at the camera. Do not change the facial structure.",
  back:
    "REQUESTED VIEW: a full back view at an exact 180-degree rear angle, standing naturally with the back directly to the camera, framed head to toe. " +
    "Show the whole back of the head, the hairstyle and hair length, neck, shoulders, upper back, waist, hips and legs. Both shoulders and the body are aligned " +
    "naturally and symmetrically with the camera. Preserve the natural proportions, shoulder width, waist, hips, physique, hair texture and hair density. " +
    "The face must NOT turn towards the camera; NOT a three-quarter rear view.",
  half:
    "REQUESTED VIEW: half-body portrait from the waist up, facing the camera, standing naturally with relaxed shoulders, both arms relaxed and both hands visible " +
    "and anatomically correct. Camera at chest height with a natural perspective. Preserve the exact facial identity, hairstyle, skin tone, shoulder width and upper-body proportions.",
  full:
    "REQUESTED VIEW: full body from the top of the head to the soles of the feet, the whole body inside the frame with a little space above the head and below the feet. " +
    "Standing naturally, facing the camera, relaxed neutral posture, both arms and both legs fully formed and anatomically correct. Camera at about waist height " +
    "with a natural perspective, no wide-angle distortion. Preserve the exact facial identity, hairstyle, skin tone, body shape, shoulder width, waist, hips, legs and " +
    "realistic head-to-body proportions. Do not lengthen the legs, narrow the waist, exaggerate curves or change the physique. No cropped feet, missing limbs or partial framing.",
};

// Same backdrop for every pose so the set reads as one character sheet.
const SHEET =
  "Same outfit and accessories as the reference (where part of the outfit is not visible, continue it in the same style and colours). " +
  "Plain light-grey seamless studio background, soft even lighting, sharp focus, exactly ONE person, no text, no logo, no watermark. Vertical 9:16 framing.";

/** The prompt for one pose of the character sheet. */
function viewPrompt(view, desc) {
  if (!VIEW_SHOT[view]) throw new Error("unknown view: " + view);
  return [
    IDENTITY,
    ADAPTIVE,
    desc ? `Known details of this person (use them, but the reference picture wins if they disagree): ${String(desc).slice(0, 600)}` : "",
    VIEW_SHOT[view],
    REALISM,
    SHEET,
    "Generate exactly ONE picture of this same individual from the requested viewpoint.",
  ].filter(Boolean).join("\n\n");
}

/** The Realistic look from your photo: a new photo of exactly you, same rules, nothing beautified. */
function realisticPrompt(extra) {
  return [
    IDENTITY,
    ADAPTIVE,
    extra ? `Extra details from the user: ${String(extra).slice(0, 600)}` : "",
    "REQUESTED VIEW: a natural, candid photo of this same person, head and shoulders, facing the camera and looking into the lens, eyes open, relaxed friendly " +
      "expression with a slight smile, both hands relaxed and out of frame or clearly visible, a new natural pose and framing (not a copy of the reference), " +
      "plain uncluttered background, soft natural daylight. Made to be animated by an AI video model.",
    "It MUST be a real photograph: an authentic phone or camera photo with natural skin texture, pores and any freckles, moles, blemishes or lines the person has. " +
      "No retouching, skin smoothing, slimming, larger eyes, whiter teeth, added make-up, younger look or beauty filter; no plastic or CGI look.",
    "Exactly ONE person, sharp focus, no text, logos or watermark. Vertical 9:16 framing.",
    "Generate exactly ONE photograph of this same individual.",
  ].filter(Boolean).join("\n\n");
}

// Where a line sits in the Short decides how a creator plays it.
const BEAT = {
  hook: "This is the HOOK, the first second of the video: stop the scroll. Lean in close to the lens, eyebrows up, wide intrigued eyes or a knowing half-smile, as if letting the viewer in on a secret.",
  point: "This is a teaching beat: confident and clear, like explaining to a friend who is genuinely curious.",
  payoff: "This is the PAYOFF, the last line: land it. A satisfied nod, a small smile or a 'mind-blown' look, open hands towards the camera, as if saying 'and that's it'.",
};

/**
 * Influencer cameo (Shorts maker, Pictures): the same person presenting one of the user's pictures, framed the way a
 * top short-form creator films an explainer. Images 1..refs are the person, the image after them is the subject being explained.
 * act: the AI's direction for this line (expression, energy, gestures); beat: hook, point or payoff.
 */
function cameoPrompt({ refs = 1, desc = "", narration = "", act = "", beat = "point" } = {}) {
  const subject = refs + 1;
  return [
    IDENTITY,
    refs > 1 ? `Images 1 to ${refs} all show this one person (image 1 is the main reference and wins if they disagree).` : "",
    ADAPTIVE,
    desc ? `Known details of this person (use them, but the reference pictures win if they disagree): ${String(desc).slice(0, 600)}` : "",
    `Image ${subject} is NOT a picture of the person to draw: it is the subject being explained.`,
    `REQUESTED VIEW: a frame from a professional short-form CONTENT CREATOR's explainer video (the "green screen" format of top TikTok / Reels / Shorts educators). ` +
      `The subject of image ${subject} fills the background like a big screen behind the creator, large, sharp and readable. ` +
      "The person is the creator: in the lower-middle foreground, framed from the waist or chest up, body angled slightly, face turned to the lens with direct eye contact, " +
      "mid-sentence and clearly talking, with a camera-ready, expressive face and a natural creator gesture: pointing at it over the shoulder or to the side, presenting it with an open palm, " +
      "or counting a point on the fingers. One natural, anatomically correct hand in the gesture.",
    BEAT[beat] || BEAT.point,
    act ? `Director's note for this line (show the expression and gesture of its FIRST beat, the moment the line starts): ${String(act).replace(/\s+/g, " ").slice(0, 400)}` : "",
    `FAITHFUL SUBJECT: keep what image ${subject} shows exactly as it is (the same objects, shapes, colours, layout, labels, numbers and text). Do not redraw it as something else, ` +
      "add to it or invent details. If it is a chart, diagram, screenshot or document, show its content unchanged, and do not let the person cover the important parts.",
    narration ? `What is being said at this moment (for the gesture and expression only; do NOT write it in the picture): "${String(narration).replace(/\s+/g, " ").slice(0, 300)}"` : "",
    "Creator lighting: a soft, flattering key light on the face with a small round catchlight in the eyes, a gentle rim light separating them from the background, " +
      "shot on a modern phone front camera, crisp focus on the face.",
    REALISM,
    "Same outfit and accessories as image 1. Exactly ONE instance of this person. Add no text, captions, logos, UI or watermark. " +
      "Vertical 9:16 framing, with the face in the middle band of the picture, clear of the top fifth and the bottom third (captions go there).",
    "Generate exactly ONE picture.",
  ].filter(Boolean).join("\n\n");
}

/**
 * Talking cameo (Shorts maker, Pictures): the cameo picture is the first frame of a short clip in which the same person
 * delivers the line like a full-time short-form creator. Silent: the influencer's voice is laid over it.
 */
function cameoTalkPrompt({ desc = "", narration = "", act = "", beat = "point" } = {}) {
  return [
    "A professional short-form content creator filming a talking-head explainer for TikTok / Reels / Shorts, straight into a phone camera, in one take. " +
      "The person in the first frame is the creator, the picture behind them is what they are explaining.",
    "Creator delivery: locked, direct eye contact with the lens; high, natural energy and punchy pacing; the mouth clearly speaking the whole time; " +
      "an expressive face that changes with the words (eyebrow raises on the surprising part, a quick smile, a knowing look); head nods and small leans toward the lens on the key word; " +
      "beat gestures that hit the emphasis; and illustrative hand gestures that SHOW the idea (counting points on fingers, pointing back at the exact part of the picture being talked about, " +
      "shaping size, movement or a before-and-after with the hands). Every gesture is purposeful and matches the words, never random waving.",
    BEAT[beat] || BEAT.point,
    narration ? `They are saying exactly these words, at a natural speaking pace, starting a quarter of a second in: "${String(narration).replace(/\s+/g, " ").slice(0, 300)}" ` +
      "(do NOT show them as text). Face, head and hands follow the words as they are spoken: each expression and gesture lands on the word it belongs to." : "",
    act ? `Director's timing notes (do each action on the quoted words): ${String(act).replace(/\s+/g, " ").slice(0, 400)}` : "",
    desc ? `The creator: ${String(desc).slice(0, 400)}` : "",
    "Camera: handheld phone feel with a slight natural sway and a subtle slow push-in toward the face, flattering soft key light, the background picture stays sharp. " +
      "Keep exactly the same face, hair, body and clothes as the first frame for the whole clip; anatomically correct hands with five fingers. " +
      "The picture behind keeps its exact content, text and layout. No cuts, no new people, no on-screen text, captions, stickers or logos.",
  ].filter(Boolean).join(" ");
}

module.exports = { IDENTITY, ADAPTIVE, REALISM, VIEW_SHOT, BEAT, viewPrompt, realisticPrompt, cameoPrompt, cameoTalkPrompt };
