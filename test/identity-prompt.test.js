const test = require("node:test");
const assert = require("node:assert");
const { viewPrompt, realisticPrompt, VIEW_SHOT } = require("../lib/identity-prompt");
const { forGender, genderOf, enhancerGuide, videoLock } = require("../lib/prompt-library");

test("poses: every view keeps the identity rules, the reference analysis and its own camera angle", () => {
  for (const v of ["front", "left", "right", "back", "half", "full"]) {
    const p = viewPrompt(v, "a woman in her 20s");
    assert.match(p, /IDENTITY PRESERVATION/);
    assert.match(p, /ADAPTIVE REFERENCE ANALYSIS/);
    assert.match(p, /Do not beautify/);
    assert.match(p, /exactly ONE picture/);
    assert.ok(p.includes(forGender(VIEW_SHOT[v], "female")), v + " has its camera instruction");
    assert.match(p, /a woman in her 20s/);
  }
  assert.match(viewPrompt("left"), /screen-LEFT[\s\S]*NOT a three-quarter/);
  assert.match(viewPrompt("right"), /screen-RIGHT/);
  assert.match(viewPrompt("back"), /180-degree[\s\S]*must NOT turn towards the camera/);
  assert.match(viewPrompt("full"), /soles of their feet[\s\S]*No cropped feet/);
  assert.throws(() => viewPrompt("sideways"));
});

test("poses keep a drawn or 3D character in its own style, and are written gender-neutral", () => {
  const p = viewPrompt("front");
  assert.match(p, /3D, anime, cartoon or illustrated, keep exactly that style/);
  assert.doesNotMatch(p, /\b(she|her|he|his)\b/i);
});

test("house prompts: word for word for a woman, pronouns matched for everyone else", () => {
  assert.equal(genderOf("a woman in her 20s"), "female");
  assert.equal(genderOf("a bearded man, his hair short"), "male");
  assert.equal(genderOf("short grey hair"), null);
  assert.match(viewPrompt("full", "a woman"), /from the top of her head to the soles of her feet[\s\S]*She is standing naturally/);
  assert.match(viewPrompt("full", "a man"), /the top of his head[\s\S]*The subject is standing naturally/);
  for (const v of ["left", "right", "back", "full"]) assert.doesNotMatch(viewPrompt(v), /\b(she|her|he|his)\b/i, v);
  assert.match(enhancerGuide(), /RECONSTRUCTION RULE:[\s\S]*PHOTOGRAPHIC REALISM:/);
  assert.match(videoLock(), /IDENTITY PRESERVATION/);
});

test("Realistic look: the same person as a real, unretouched photo", () => {
  const p = realisticPrompt("wears a red scarf");
  assert.match(p, /IDENTITY PRESERVATION/);
  assert.match(p, /MUST be a real photograph/);
  assert.match(p, /No retouching, skin smoothing/);
  assert.match(p, /wears a red scarf/);
  assert.doesNotMatch(realisticPrompt(""), /Extra details/);
});
