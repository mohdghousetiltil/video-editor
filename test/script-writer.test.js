const test = require("node:test");
const assert = require("node:assert");
const { GENRES, MAIN, systemPrompt } = require("../lib/script-writer");

test("scripts: rom-com, comedy, kids and new gen lead; story and visuals are separate blocks", () => {
  assert.deepEqual(MAIN, ["romcom", "comedy", "kids", "newgen"]);
  for (const g of Object.keys(GENRES)) {
    const p = systemPrompt({ genre: g, secs: 30 });
    assert.match(p, /NEVER mix the story with the visuals/);
    assert.match(p, /\nSTORY:\n[\s\S]*\nVISUALS:\n/);
    assert.ok(p.includes(GENRES[g].label), g);
  }
  assert.match(systemPrompt({ genre: "kids" }), /safe, kind and age-appropriate/);
  assert.match(systemPrompt({ genre: "mix" }), /If they don't say, choose from romantic comedy, comedy, a children's story or a new-gen story/);
  assert.doesNotMatch(systemPrompt({ genre: "romcom" }), /suspense writer|horror:/);
});
