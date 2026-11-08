'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { CONFIG_KEYS, CONFIG_DEFAULTS, BLOCK_ON_VALUES, configPaths, resolveConfigValue, readCapabilityConfig } = require('../lib/config.cjs');

const CWD = path.join(path.sep, 'proj');
const ROOT_CONFIG = path.join(CWD, '.planning', 'config.json');

/** A readFile stub over absolute-path -> text; unknown paths throw. Records every path asked for. */
function reader(files) {
  const asked = [];
  const readFile = (p) => {
    asked.push(p);
    if (!Object.prototype.hasOwnProperty.call(files, p)) throw new Error(`ENOENT ${p}`);
    return files[p];
  };
  return { readFile, asked };
}

const nested = (obj) => JSON.stringify({ 'standing-orders': obj });

describe('config', () => {
  it('defaultsWhenNoConfig', () => {
    const { readFile } = reader({});
    const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.blockOn, 'conflict');
    assert.equal(cfg.maxBytes, 6000);
    assert.deepEqual(cfg.warnings, []);
  });

  it('readsNestedRootKeys', () => {
    const { readFile } = reader({ [ROOT_CONFIG]: nested({ enabled: true, block_on: 'never', max_bytes: 1234 }) });
    const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.blockOn, 'never');
    assert.equal(cfg.maxBytes, 1234);
    assert.deepEqual(cfg.warnings, []);
    assert.deepEqual(resolveConfigValue('standing-orders.block_on', { cwd: CWD, env: {}, readFile }), { found: true, value: 'never' });
    assert.deepEqual(resolveConfigValue('standing-orders.absent', { cwd: CWD, env: {}, readFile }), { found: false, value: undefined });
  });

  it('ignoresFlatDottedKey', () => {
    const { readFile } = reader({ [ROOT_CONFIG]: JSON.stringify({ 'standing-orders.enabled': true, 'standing-orders.max_bytes': 5 }) });
    const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.maxBytes, 6000);
    assert.deepEqual(resolveConfigValue('standing-orders.enabled', { cwd: CWD, env: {}, readFile }), { found: false, value: undefined });
  });

  it('workstreamThenRootPerKey', () => {
    const wsConfig = path.join(CWD, '.planning', 'workstreams', 'ws1', 'config.json');
    const { readFile } = reader({
      [wsConfig]: nested({ block_on: 'never' }),
      [ROOT_CONFIG]: nested({ enabled: true, block_on: 'conflict_or_missing', max_bytes: 100 }),
    });
    const cfg = readCapabilityConfig({ cwd: CWD, env: { GSD_WORKSTREAM: 'ws1' }, readFile });
    assert.equal(cfg.blockOn, 'never');
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.maxBytes, 100);
    assert.deepEqual(configPaths(CWD, { GSD_WORKSTREAM: 'ws1' }), [wsConfig, ROOT_CONFIG]);
  });

  it('projectDirectoryComesBeforeWorkstream', () => {
    const projCfg = path.join(CWD, '.planning', 'p1', 'workstreams', 'ws1', 'config.json');
    assert.deepEqual(configPaths(CWD, { GSD_PROJECT: 'p1', GSD_WORKSTREAM: 'ws1' }), [projCfg, ROOT_CONFIG]);
    assert.deepEqual(configPaths(CWD, { GSD_PROJECT: ' p1 ' }), [path.join(CWD, '.planning', 'p1', 'config.json'), ROOT_CONFIG]);
    assert.deepEqual(configPaths(CWD, {}), [ROOT_CONFIG]);
    assert.deepEqual(configPaths(CWD, { GSD_PROJECT: '   ', GSD_WORKSTREAM: '' }), [ROOT_CONFIG]);
  });

  it('rejectsTraversalWorkstream', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', 'x..y/z']) {
      assert.deepEqual(configPaths(CWD, { GSD_WORKSTREAM: bad }), [ROOT_CONFIG], `workstream ${JSON.stringify(bad)}`);
      assert.deepEqual(configPaths(CWD, { GSD_PROJECT: bad }), [ROOT_CONFIG], `project ${JSON.stringify(bad)}`);
    }
    const { readFile, asked } = reader({ [ROOT_CONFIG]: nested({ enabled: true }) });
    const cfg = readCapabilityConfig({ cwd: CWD, env: { GSD_WORKSTREAM: '../..' }, readFile });
    assert.equal(cfg.enabled, true);
    const planning = path.join(CWD, '.planning') + path.sep;
    for (const p of asked) assert.ok(p.startsWith(planning), `read stays under .planning: ${p}`);
  });

  it('nonObjectConfigIsAbsent', () => {
    for (const text of ['this is not json', '0', '"s"', '[]', 'null', '']) {
      const { readFile } = reader({ [ROOT_CONFIG]: text });
      const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
      assert.equal(cfg.enabled, false, `text ${JSON.stringify(text)}`);
      assert.equal(cfg.blockOn, 'conflict');
      assert.equal(cfg.maxBytes, 6000);
      assert.deepEqual(cfg.warnings, []);
    }
    // an unusable workstream file does not hide a good root file
    const wsConfig = path.join(CWD, '.planning', 'workstreams', 'w', 'config.json');
    const { readFile } = reader({ [wsConfig]: 'not json', [ROOT_CONFIG]: nested({ enabled: true }) });
    assert.equal(readCapabilityConfig({ cwd: CWD, env: { GSD_WORKSTREAM: 'w' }, readFile }).enabled, true);
  });

  it('invalidBlockOnFallsBack', () => {
    for (const bad of ['sometimes', 5]) {
      const { readFile } = reader({ [ROOT_CONFIG]: nested({ block_on: bad }) });
      const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
      assert.equal(cfg.blockOn, 'conflict');
      assert.equal(cfg.warnings.length, 1);
      assert.equal(cfg.warnings[0].code, 'config_invalid');
      assert.equal(cfg.warnings[0].key, 'standing-orders.block_on');
      assert.ok(cfg.warnings[0].message.includes('standing-orders.block_on'));
      assert.ok(cfg.warnings[0].message.includes(JSON.stringify(bad)));
    }
  });

  it('invalidMaxBytesFallsBack', () => {
    const rawValues = ['"6000"', '-1', '1.5', '1e400', 'true', 'null'];
    for (const raw of rawValues) {
      const { readFile } = reader({ [ROOT_CONFIG]: `{"standing-orders":{"max_bytes":${raw}}}` });
      const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
      assert.equal(cfg.maxBytes, 6000, `max_bytes ${raw}`);
      assert.equal(cfg.warnings.length, 1, `max_bytes ${raw}`);
      assert.equal(cfg.warnings[0].code, 'config_invalid');
      assert.equal(cfg.warnings[0].key, 'standing-orders.max_bytes');
      assert.ok(cfg.warnings[0].message.includes('standing-orders.max_bytes'));
    }
    const { readFile } = reader({ [ROOT_CONFIG]: nested({ max_bytes: '6000' }) });
    assert.ok(readCapabilityConfig({ cwd: CWD, env: {}, readFile }).warnings[0].message.includes('"6000"'));
  });

  it('zeroMaxBytesIsValid', () => {
    const { readFile } = reader({ [ROOT_CONFIG]: nested({ max_bytes: 0 }) });
    const cfg = readCapabilityConfig({ cwd: CWD, env: {}, readFile });
    assert.equal(cfg.maxBytes, 0);
    assert.deepEqual(cfg.warnings, []);
  });

  it('enabledFollowsHostCoercion', () => {
    const enabledFor = (value) => {
      const { readFile } = reader({ [ROOT_CONFIG]: JSON.stringify({ 'standing-orders': { enabled: value } }) });
      return readCapabilityConfig({ cwd: CWD, env: {}, readFile }).enabled;
    };
    assert.equal(enabledFor('false'), true);
    assert.equal(enabledFor(true), true);
    assert.equal(enabledFor(1), true);
    assert.equal(enabledFor(false), false);
    assert.equal(enabledFor(0), false);
    assert.equal(enabledFor(''), false);
    assert.equal(enabledFor(null), false);
  });

  it('prototypeSegmentsAreNotFound', () => {
    const text = '{"__proto__":{"enabled":true},"standing-orders":{"constructor":{"x":1}}}';
    const { readFile } = reader({ [ROOT_CONFIG]: text });
    assert.deepEqual(resolveConfigValue('__proto__.enabled', { cwd: CWD, env: {}, readFile }), { found: false, value: undefined });
    assert.deepEqual(resolveConfigValue('standing-orders.constructor.x', { cwd: CWD, env: {}, readFile }), { found: false, value: undefined });
    assert.deepEqual(resolveConfigValue('standing-orders.toString', { cwd: CWD, env: {}, readFile }), { found: false, value: undefined });
  });

  it('defaultsMatchManifest', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'capability.json'), 'utf8'));
    assert.deepEqual(Object.keys(manifest.config).sort(), Object.values(CONFIG_KEYS).sort());
    for (const [key, spec] of Object.entries(manifest.config)) {
      assert.deepEqual(spec.default, CONFIG_DEFAULTS[key], `default of ${key}`);
    }
    assert.deepEqual(manifest.config['standing-orders.block_on'].values, [...BLOCK_ON_VALUES]);
    assert.deepEqual([...BLOCK_ON_VALUES], ['conflict', 'conflict_or_missing', 'never']);
    assert.equal(CONFIG_KEYS.enabled, 'standing-orders.enabled');
    assert.equal(CONFIG_KEYS.blockOn, 'standing-orders.block_on');
    assert.equal(CONFIG_KEYS.maxBytes, 'standing-orders.max_bytes');
  });
});
