// Prompts for making new pictures of the SAME person from one reference picture: the body profiles ("poses") and the
// Realistic look. Identity comes first: the reference is the source of truth, nothing is beautified, redesigned or invented.
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

module.exports = { IDENTITY, ADAPTIVE, REALISM, VIEW_SHOT, viewPrompt, realisticPrompt };
