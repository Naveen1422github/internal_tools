const fs = require('fs/promises');
const fsSync = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WORKSPACE_INFO_TTL_MS = 5000;
const AGENTS_TTL_MS = 30000;
const GIT_EXEC_OPTS = { windowsHide: true, timeout: 5000 };
const MAX_TREE_ENTRIES = 500;
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

const agents = require('./agents');

let workspaceInfoCache = { ts: 0, data: null };
let agentsCache = { ts: 0, data: null };

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseShortStat(statText) {
  const text = String(statText || '').trim();
  if (!text) return { add: 0, del: 0, files: 0 };

  const files = Number((text.match(/(\d+)\s+files?\s+changed/i) || [])[1] || 0);
  const add = Number((text.match(/(\d+)\s+insertions?\(\+\)/i) || [])[1] || 0);
  const del = Number((text.match(/(\d+)\s+deletions?\(-\)/i) || [])[1] || 0);
  return { add, del, files };
}

async function getWorkspaceInfo() {
  const now = Date.now();
  if (workspaceInfoCache.data && now - workspaceInfoCache.ts < WORKSPACE_INFO_TTL_MS) {
    return workspaceInfoCache.data;
  }

  let branch = null;
  let diff = { add: 0, del: 0, files: 0 };

  try {
    const branchOut = await execFileAsync('git', ['branch', '--show-current'], GIT_EXEC_OPTS);
    branch = String(branchOut.stdout || '').trim() || null;
  } catch {
    branch = null;
  }

  try {
    const diffOut = await execFileAsync('git', ['diff', '--shortstat', 'HEAD'], GIT_EXEC_OPTS);
    diff = parseShortStat(diffOut.stdout);
  } catch {
    diff = { add: 0, del: 0, files: 0 };
  }

  const data = {
    name: path.basename(process.cwd()),
    cwd: process.cwd(),
    branch,
    diff,
  };
  workspaceInfoCache = { ts: now, data };
  return data;
}

function getCodexCooldown() {
  try {
    const trackerPath = path.join(os.homedir(), '.codex', 'profiles', 'tracker.json');
    const raw = fsSync.readFileSync(trackerPath, 'utf8');
    const tracker = JSON.parse(raw);
    const active = tracker.active_profile;
    if (!active || !tracker.profiles || !tracker.profiles[active]) return null;
    const resetAt = tracker.profiles[active].limit_resets_at;
    if (!resetAt) return null;
    const resetMs = new Date(resetAt).getTime();
    if (!Number.isFinite(resetMs) || resetMs <= Date.now()) return null;
    return new Date(resetMs).toISOString();
  } catch {
    return null;
  }
}

async function getAgentsInfo() {
  const now = Date.now();
  if (agentsCache.data && now - agentsCache.ts < AGENTS_TTL_MS) return agentsCache.data;

  const result = {};
  const entries = Object.entries(agents);
  for (const [name, adapter] of entries) {
    let detected;
    try {
      detected = await adapter.detect();
    } catch (err) {
      detected = { ok: false, hint: err.message };
    }

    const payload = {
      ok: Boolean(detected && detected.ok),
      label: 'missing',
    };

    if (detected && detected.version) payload.version = detected.version;
    if (detected && detected.hint) payload.hint = detected.hint;

    if (!payload.ok) {
      payload.label = name === 'jules' ? 'cloud-only' : 'missing';
    } else if (name === 'codex') {
      const cooldownEndsAt = getCodexCooldown();
      if (cooldownEndsAt) {
        payload.label = 'cooldown';
        payload.cooldownEndsAt = cooldownEndsAt;
      } else {
        payload.label = 'ready';
      }
    } else {
      payload.label = 'ready';
    }

    result[name] = payload;
  }

  agentsCache = { ts: now, data: result };
  return result;
}

function isSafeRelativePath(relPath) {
  if (!relPath) return true;
  if (relPath.includes('..')) return false;
  if (relPath.startsWith('/') || relPath.startsWith('\\')) return false;
  return true;
}

function shouldSkipEntry(dirent, relPath, absPath) {
  const name = dirent.name;
  if (dirent.isDirectory()) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === '.next' || name === '.angular') {
      return true;
    }
    if (name.startsWith('.')) return true;
    return false;
  }

  if (name.startsWith('.') && name !== '.gitignore' && name !== '.env.example') return true;

  try {
    const stat = fsSync.statSync(absPath);
    if (stat.size > MAX_FILE_SIZE_BYTES) return true;
  } catch {
    return true;
  }

  return false;
}

async function buildTree(absPath, relPath, depth, state) {
  if (state.count >= MAX_TREE_ENTRIES) return [];
  const dirents = await fs.readdir(absPath, { withFileTypes: true });

  const entries = [];
  for (const dirent of dirents) {
    const childRel = relPath ? path.posix.join(relPath, dirent.name) : dirent.name;
    const childAbs = path.join(absPath, dirent.name);
    if (shouldSkipEntry(dirent, childRel, childAbs)) continue;

    entries.push({
      name: dirent.name,
      type: dirent.isDirectory() ? 'dir' : 'file',
      path: childRel,
      children: dirent.isDirectory() ? [] : undefined,
    });
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of entries) {
    if (state.count >= MAX_TREE_ENTRIES) break;
    state.count += 1;
    if (entry.type === 'dir' && depth > 1) {
      entry.children = await buildTree(path.join(absPath, entry.name), entry.path, depth - 1, state);
    }
  }

  return entries;
}

module.exports.routes = {
  'GET /api/workspace/info': async (req, res, send) => {
    const data = await getWorkspaceInfo();
    send(200, data);
  },

  'GET /api/workspace/agents': async (req, res, send) => {
    const data = await getAgentsInfo();
    send(200, data);
  },

  'GET /api/workspace/files': async (req, res, send) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const relPath = String(url.searchParams.get('path') || '').trim();
    const depthRaw = Number(url.searchParams.get('depth') || 2);
    const depth = Number.isFinite(depthRaw) ? Math.max(1, Math.min(4, Math.floor(depthRaw))) : 2;

    if (!isSafeRelativePath(relPath)) return send(400, { error: 'invalid path' });

    const cwd = process.cwd();
    const resolved = path.resolve(cwd, relPath);
    const relFromCwd = path.relative(cwd, resolved);
    if (relFromCwd.startsWith('..') || path.isAbsolute(relFromCwd)) {
      return send(400, { error: 'path escapes workspace' });
    }

    let stat;
    try {
      stat = await fs.stat(resolved);
    } catch {
      return send(404, { error: 'path not found' });
    }
    if (!stat.isDirectory()) return send(400, { error: 'path must be a directory' });

    const state = { count: 0 };
    const entries = await buildTree(resolved, relPath.replace(/\\/g, '/'), depth, state);
    send(200, { path: relPath.replace(/\\/g, '/'), entries });
  },
};
