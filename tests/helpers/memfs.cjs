'use strict';

/**
 * In-memory filesystem for router tests: no real disk is touched.
 *
 * `files`: project-relative path -> text (parent directories are implied).
 * `dirs`: extra empty project-relative directories.
 * `links`: project-relative path -> absolute path `realpath` returns for it; `isSymlink` is true for
 * every declared link, dangling or not.
 * `overrides`: replace any dep (an IO failure is a dep that throws; never chmod).
 * `now` defaults to a fixed Date (2026-11-08T00:00:00.000Z); override it to move the clock.
 *
 * `calls` records, in call order: readFile (path), writeFile (path), appendFile (path), rename
 * ([from, to]), mkdir (path), execFile ({ file, args, opts }), log (message),
 * error (message).
 */

const path = require('node:path');

const CWD = path.resolve(path.sep, 'proj');
const DEFAULT_NOW = '2026-11-08T00:00:00.000Z';

function enoent(p) {
  const e = new Error(`ENOENT: no such file or directory, '${p}'`);
  e.code = 'ENOENT';
  return e;
}

function memfs({ files = {}, dirs = [], links = {}, cwd = CWD, overrides = {} } = {}) {
  const abs = (rel) => path.resolve(cwd, rel);
  const fileMap = new Map();
  const dirSet = new Set();
  const linkMap = new Map();

  const addDirs = (p) => {
    let d = p;
    for (;;) {
      dirSet.add(d);
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
  };

  addDirs(cwd);
  for (const [rel, text] of Object.entries(files)) {
    fileMap.set(abs(rel), String(text));
    addDirs(path.dirname(abs(rel)));
  }
  for (const rel of dirs) addDirs(abs(rel));
  for (const [rel, target] of Object.entries(links)) {
    linkMap.set(abs(rel), target);
    addDirs(path.dirname(abs(rel)));
  }

  const calls = { readFile: [], writeFile: [], appendFile: [], rename: [], mkdir: [], execFile: [], log: [], error: [] };
  const known = (p) => fileMap.has(p) || dirSet.has(p) || linkMap.has(p);

  const deps = {
    exists: (p) => known(p),
    isFile: (p) => fileMap.has(p),
    isSymlink: (p) => linkMap.has(p),
    realpath: (p) => {
      if (linkMap.has(p)) return linkMap.get(p);
      if (known(p)) return p;
      throw enoent(p);
    },
    statSize: (p) => {
      if (!fileMap.has(p)) throw enoent(p);
      return Buffer.byteLength(fileMap.get(p), 'utf8');
    },
    readFile: (p) => {
      calls.readFile.push(p);
      if (!fileMap.has(p)) throw enoent(p);
      return fileMap.get(p);
    },
    listDir: (p) => {
      if (!dirSet.has(p)) throw enoent(p);
      const names = new Set();
      for (const f of fileMap.keys()) if (path.dirname(f) === p) names.add(path.basename(f));
      for (const d of dirSet) if (d !== p && path.dirname(d) === p) names.add(path.basename(d));
      for (const l of linkMap.keys()) if (path.dirname(l) === p) names.add(path.basename(l));
      return [...names].sort();
    },
    writeFile: (p, text) => {
      calls.writeFile.push(p);
      fileMap.set(p, String(text));
      addDirs(path.dirname(p));
    },
    appendFile: (p, text) => {
      calls.appendFile.push(p);
      fileMap.set(p, (fileMap.has(p) ? fileMap.get(p) : '') + String(text));
      addDirs(path.dirname(p));
    },
    now: () => new Date(DEFAULT_NOW),
    rename: (from, to) => {
      calls.rename.push([from, to]);
      if (!fileMap.has(from)) throw enoent(from);
      fileMap.set(to, fileMap.get(from));
      fileMap.delete(from);
    },
    mkdir: (p) => {
      calls.mkdir.push(p);
      addDirs(p);
    },
    execFile: (file, args, opts) => {
      calls.execFile.push({ file, args, opts });
      throw new Error('execFile not stubbed');
    },
    env: {},
    argv: ['node', '/not/the/host.cjs'],
    nodePath: '/usr/bin/node',
    log: (m) => {
      calls.log.push(m);
    },
    ...overrides,
  };

  const error = (m) => {
    calls.error.push(m);
  };

  return {
    deps,
    error,
    calls,
    read: (rel) => fileMap.get(abs(rel)),
    has: (rel) => fileMap.has(abs(rel)),
    cwd,
  };
}

module.exports = { memfs, CWD, DEFAULT_NOW };
