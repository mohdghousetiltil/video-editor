const test = require("node:test");
const assert = require("node:assert");
const { viewPrompt, realisticPrompt, VIEW_SHOT } = require("../lib/identity-prompt");

test("poses: every view keeps the identity rules, the reference analysis and its own camera angle", () => {
  for (const v of ["front", "left", "right", "back", "half", "full"]) {
    const p = viewPrompt(v, "a woman in her 20s");
    assert.match(p, /IDENTITY PRESERVATION/);
    assert.match(p, /ADAPTIVE REFERENCE ANALYSIS/);
    assert.match(p, /Do not beautify/);
    assert.match(p, /exactly ONE picture/);
    assert.ok(p.includes(VIEW_SHOT[v]), v + " has its camera instruction");
    assert.match(p, /a woman in her 20s/);
  }
  assert.match(viewPrompt("left"), /screen-LEFT[\s\S]*NOT a three-quarter/);
  assert.match(viewPrompt("right"), /screen-RIGHT/);
  assert.match(viewPrompt("back"), /180-degree[\s\S]*must NOT turn towards the camera/);
  assert.match(viewPrompt("full"), /soles of the feet[\s\S]*No cropped feet/);
  assert.throws(() => viewPrompt("sideways"));
});

test("poses keep a drawn or 3D character in its own style, and are written gender-neutral", () => {
  const p = viewPrompt("front");
  assert.match(p, /3D, anime, cartoon or illustrated, keep exactly that style/);
  assert.doesNotMatch(p, /\b(she|her|he|his)\b/i);
});

test("Realistic look: the same person as a real, unretouched photo", () => {
  const p = realisticPrompt("wears a red scarf");
  assert.match(p, /IDENTITY PRESERVATION/);
  assert.match(p, /MUST be a real photograph/);
  assert.match(p, /No retouching, skin smoothing/);
  assert.match(p, /wears a red scarf/);
  assert.doesNotMatch(realisticPrompt(""), /Extra details/);
});
