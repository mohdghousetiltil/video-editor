// The house prompt standard: the owner's own character-reconstruction prompts, kept word for word. Everything that
// draws or films a saved person builds on these blocks (lib/identity-prompt.js, the prompt enhancer, video clips).
// The wording was written about a woman; forGender() swaps the pronouns for other people.

const HEAD = `You are an expert AI character reconstruction and photorealistic photography system.
Your task is to analyse the provided reference photograph and generate a new, highly realistic photograph of THE EXACT SAME PERSON from a different camera angle.
PRIMARY OBJECTIVE: IDENTITY PRESERVATION.
The reference image defines the person's identity. It is the absolute source of truth.
Preserve the person's:

* Exact facial identity and facial geometry.
* Eye shape, eye spacing, eyebrows, nose, lips and jawline.
* Skin tone, complexion and natural skin characteristics.
* Hair colour, texture, length, density and hairstyle.
* Body proportions, physique and natural anatomical characteristics.
* Distinctive physical characteristics and identifying details.`;
const INTERPRETATION = `REFERENCE INTERPRETATION:
The input may be any type of photograph, including:

* Close-up selfies and headshots.
* Mirror selfies.
* Half-body and full-body photographs.
* Fashion, lifestyle and editorial photography.
* Indoor or outdoor photographs.
* Sitting, standing, walking or unconventional poses.
* Photographs with different lighting, camera lenses and perspectives.

Intelligently interpret the available visual information. Do not assume the reference is a studio photograph or that the person is facing the camera.
Distinguish between the person's permanent physical characteristics and temporary photographic characteristics such as lighting, camera distortion, shadows, pose and perspective.`;
const RECONSTRUCTION = `RECONSTRUCTION RULE:
Generate a physically coherent representation of the same individual. Do not beautify, redesign, idealise, reinterpret or create a lookalike.
When a physical feature is not visible in the reference, use only reasonable anatomical continuity with the visible information. Never invent distinctive identifying features.`;
const PHOTO_REALISM = `PHOTOGRAPHIC REALISM:
The output must look like an authentic photograph captured by a professional photographer, not an AI-generated character render.
Maintain realistic human anatomy, natural skin texture, believable proportions, realistic hair strands, accurate perspective, natural shadows and physically consistent lighting.
No artificial skin smoothing, plastic appearance, exaggerated curves, distorted anatomy, duplicated limbs, artificial facial features or CGI aesthetics.`;
const OUTPUT = `OUTPUT REQUIREMENT:
Generate exactly ONE photograph, following the requested camera angle and composition.
The result must depict the same individual, not a person who merely resembles the reference.`;
const SIDE = `Generate a photorealistic 90-degree side-profile photograph of the exact same person in the reference image.

The subject is positioned in a natural upright posture, with her entire head rotated precisely 90 degrees away from the camera. Her visible eye, nose bridge, nose tip, lips, chin and jawline must form a natural, anatomically accurate side silhouette.

Preserve her exact facial identity, forehead shape, nose structure, lips, chin projection, hairstyle, hairline, skin tone and natural neck proportions.

The camera must capture a genuine side view, not a three-quarter angle.

Natural posture, realistic anatomical proportions, authentic photographic details. Do not modify her facial structure.`;
const BACK = `Generate a photorealistic full back-view photograph of the exact same individual.

The subject is standing naturally with her back directly facing the camera, positioned at a precise 180-degree rear angle.

Show the complete back of her head, hairstyle, hair length, shoulders, neck, upper back, waist, hips and legs where visible in the requested framing.

Preserve the subject's natural body proportions, shoulder width, waist structure, hip proportions, physique, hair texture, hair density and overall physical appearance.

Both shoulders and the body must be aligned naturally and symmetrically with the camera.

The face must not turn towards the camera. Do not generate a three-quarter rear view.

Authentic human anatomy, natural posture and realistic photographic detail.`;
const FULL = `Generate a photorealistic full-body photograph of the exact same person in the reference image.

Show the individual from the top of her head to the soles of her feet, with the entire body completely visible inside the frame.

She is standing naturally, facing the camera, with a relaxed neutral posture and anatomically natural alignment.

Preserve her exact facial identity, hairstyle, skin tone, body shape, natural proportions, shoulder width, waist, hips, legs and overall physique.

Maintain realistic body-to-head proportions. Do not elongate the legs, narrow the waist, exaggerate curves or alter her natural physique.

Use a natural standing pose, with both arms and legs fully formed and anatomically correct.

The camera should be positioned at approximately waist height with a natural perspective, avoiding wide-angle body distortion.

No cropped feet, missing limbs or partial body framing.`;
const REAR_34 = `Generate a highly realistic three-quarter rear photograph of the exact same individual.

Position the subject approximately 135 degrees relative to the camera, revealing predominantly her back with a natural partial view of one side of her face.

Preserve her identity, hairstyle, hairline, facial profile, neck, shoulder structure and natural body proportions.

The pose should reveal the transition between the back, shoulder, waist and side silhouette without unnatural twisting.

The head and torso must be physically aligned in a believable pose.

Do not change her physique or invent additional physical characteristics.`;
const ADAPTIVE = `ADAPTIVE REFERENCE ANALYSIS:
Before generating the requested photograph, internally determine:

1. What parts of the subject are clearly visible?
2. What is the original camera angle?
3. What is the subject's current body orientation?
4. Which physical characteristics can be reliably identified?
5. Which characteristics are partially or completely occluded?
6. What anatomical information can reasonably be reconstructed from the available visual evidence?

Do not blindly reproduce the original photograph's composition.
The requested output camera angle takes priority over the reference photograph's original camera angle.
If the reference is a close-up selfie, reconstruct the visible identity and use anatomically coherent proportions rather than copying selfie lens distortion.
If the reference is a mirror selfie, distinguish the subject from the reflected environment and reproduce the actual person.
If the reference is a sitting photograph, do not preserve the sitting pose when a standing full-body output is requested.
If the reference is a side-facing photograph, correctly interpret the visible facial geometry before generating other views.
If the subject is partially obscured, do not fabricate distinctive physical details.
The final output must look like a genuine photograph of the same person taken from the requested viewpoint.`;

// "female" | "male" | null, from a person's description
function genderOf(desc) {
  const d = String(desc || "");
  const f = /\b(woman|female|girl|lady|she|her)\b/i.test(d), m = /\b(man|male|boy|guy|gentleman|he|his)\b/i.test(d);
  return f === m ? null : f ? "female" : "male";
}
// the same words for anyone: unchanged for a woman, "his" for a man, "their" when the description doesn't say
function forGender(text, gender) {
  if (gender === "female") return text;
  const his = gender === "male";
  return text.replace(/\bShe is\b/g, "The subject is").replace(/\bshe is\b/g, "the subject is").replace(/\bShe\b/g, "The subject").replace(/\bshe\b/g, "the subject")
    .replace(/\bHer\b/g, his ? "His" : "Their").replace(/\bher\b/g, his ? "his" : "their");
}

// For drawn and 3D characters: the photograph rules must not turn them into a photo.
const KEEP_MEDIUM = "MEDIUM: match the reference. If the reference is 3D, anime, cartoon or illustrated, keep exactly that style, with the same identity rules " +
  "(this overrides every instruction above or below that asks for a photograph or photorealism).";

// Appended to a video prompt when the clip starts from (or follows) a saved person's picture.
const videoLock = () => "PRIMARY OBJECTIVE: IDENTITY PRESERVATION for the whole clip. The first frame / reference picture defines the person: keep the exact facial identity " +
  "and facial geometry, eyes, eyebrows, nose, lips and jawline, skin tone and texture, hair, body proportions and distinctive details in every frame. Do not beautify, redesign " +
  "or drift into a lookalike. Natural human anatomy and movement, consistent lighting; no skin smoothing, plastic look, distorted anatomy or duplicated limbs. " +
  "Keep the medium of the reference (a photo stays a real photo, a drawn or 3D character stays in that style).";

// What the "Enhance prompt" writer follows when it turns a rough idea into a video prompt.
const enhancerGuide = () => "HOUSE PROMPT STANDARD, follow it in every prompt you write. When a person appears, state their identity once, concretely, and keep it unchanged for the whole shot.\n" +
  RECONSTRUCTION + "\n" + PHOTO_REALISM + "\n(For video, read 'photograph' as 'footage'. If the idea or the visual style is animated, drawn or 3D, keep that style and drop the photographic wording.)\n" +
  "Work out internally what is visible, the camera angle, body orientation and what could go wrong (extra limbs, face drift, lens distortion), and write the prompt so it can't. " +
  "Name the camera angle, framing, body position and natural posture precisely.";

module.exports = { HEAD, INTERPRETATION, RECONSTRUCTION, PHOTO_REALISM, OUTPUT, SIDE, BACK, FULL, REAR_34, ADAPTIVE, KEEP_MEDIUM, genderOf, forGender, videoLock, enhancerGuide };
