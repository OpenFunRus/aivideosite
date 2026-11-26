/* Offline checks for all hand-written H3 First/Last Frame splice presets. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'app/static/v2/js/workspaces/splice-presets.js'), 'utf8');
const context = { window: {} };
vm.runInNewContext(script, context, { filename: 'splice-presets.js' });
const catalog = context.window.AIVideoSplicePresets;

test('exactly five distinct prompts per transition category', () => {
  assert.deepEqual(Array.from(catalog.groups, group => group.items.length), [5, 5, 5]);
  assert.equal(new Set(catalog.groups.map(group => group.id)).size, 3);
  const items = catalog.groups.flatMap(group => group.items);
  assert.equal(items.length, 15);
  assert.equal(new Set(items.map(item => item.id)).size, 15);
  assert.equal(new Set(items.map(item => item.prompt)).size, 15);
  assert.ok(items.some(item => item.id === catalog.defaultId));
});

test('each preset is a valid, editable, silent H3 prompt', () => {
  for (const item of catalog.groups.flatMap(group => group.items)) {
    assert.ok(item.name.length > 7, item.id);
    assert.ok(item.description.length > 20, item.id);
    assert.ok(item.prompt.length > 1100 && item.prompt.length < 8000, item.id);
    assert.match(item.prompt, /^integrated_multimodal_description: \[Shot 1\]/);
    assert.match(item.prompt, /FIRST supplied image/);
    assert.match(item.prompt, /SECOND supplied image/);
    assert.match(item.prompt, /overall_soundscape:/);
    assert.match(item.prompt, /non_diegetic_music: N\/A/);
    assert.match(item.prompt, /speech_policy: silent/);
    assert.match(item.prompt, /NO dialogue/);
    assert.match(item.prompt, /guitar/);
  }
});

test('UI loads preset catalog before splice workspace and has a selector', () => {
  const template = fs.readFileSync(path.join(root, 'app/templates/v2.html'), 'utf8');
  const repairView = fs.readFileSync(path.join(root, 'app/templates/v2/views/repair.html'), 'utf8');
  assert.ok(template.indexOf('workspaces/splice-presets.js') < template.indexOf('workspaces/repair.js'));
  assert.match(repairView, /id="v2-repair-splice-preset"/);
  assert.doesNotMatch(repairView, /v2-repair-splice-prompt-reset/);
});
