/*
 * JS port of selected functions from `src/lol_draft_parser.py`.
 *
 * This file is authored as an ES module (ESM).
 * Use it with:
 *   node -e "import('./src/lol_draft_parser.js').then(m=>console.log(Object.keys(m)))"
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';


function lcuError(message) {
  const err = new Error(message);
  err.name = 'LcuError';
  return err;
}

function liveClientError(message) {
  const err = new Error(message);
  err.name = 'LiveClientError';
  return err;
}

/**
 * @param {string} contents
 * @returns {{ pid:number, port:number, password:string, protocol:'http'|'https' }}
 */
function parseLockfile(contents) {
  const parts = String(contents || '').trim().split(':');
  if (parts.length !== 5) throw lcuError('Invalid lockfile format.');

  const pid = Number(parts[1]);
  const port = Number(parts[2]);
  const password = parts[3];
  const protocol = String(parts[4] || '').trim().toLowerCase();

  if (!Number.isFinite(pid) || !Number.isFinite(port)) throw lcuError('Invalid lockfile pid/port.');
  if (protocol !== 'http' && protocol !== 'https') throw lcuError(`Unexpected lockfile protocol: ${protocol}`);

  return { pid, port, password, protocol };
}

function readLockfile(lockfilePath) {
  if (!lockfilePath) throw lcuError('lockfilePath is required.');

  let p = lockfilePath;
  // Allow passing install directory.
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    p = path.join(p, 'lockfile');
  }

  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) throw lcuError(`Lockfile not found at: ${p}`);
  return fs.readFileSync(p, 'utf8');
}

function isWindows() {
  return process.platform === 'win32';
}

function powershellGetLeagueClientUxCmdlines() {
  if (!isWindows()) return [];

  const ps = "Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object -ExpandProperty CommandLine | ConvertTo-Json -Compress";
  try {
    const proc = spawnSync('powershell', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
    });

    if (proc.status !== 0) return [];
    const raw = String(proc.stdout || '').trim();
    if (!raw) return [];

    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'string') return [parsed];
      if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
      return [];
    } catch {
      // Sometimes PowerShell output isn't clean JSON; fall back to line splitting.
      return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    return [];
  }
}

function extractInstallDirAndPort(cmdline) {
  if (typeof cmdline !== 'string' || !cmdline) return { installDir: null, port: null };

  let installDir = null;
  let port = null;

  // --install-directory="C:\Riot Games\..." or --install-directory=C:\Riot Games\...
  {
    const m = cmdline.match(/--install-directory(?:=|\s+)(?:\"([^\"]+)\"|([^\s]+))/i);
    if (m) installDir = String(m[1] || m[2] || '').trim().replace(/^"|"$/g, '');
  }

  // --app-port=12345 or --app-port 12345
  {
    const m = cmdline.match(/--app-port(?:=|\s+)(\d+)/i);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) port = n;
    }
  }

  return { installDir, port };
}

function extractDirAndPortFromCmd({ live = false } = {}) {
  const cmdlines = powershellGetLeagueClientUxCmdlines();
  let found = false;
  let installDir = null;
  let port = null;
  let client = null;

  for (const cmd of cmdlines) {
    const lower = String(cmd).toLowerCase();
    if (!live) {
      // TR mode: pick the Tournament Realm client
      if (!lower.includes('loltmnt')) continue;

      // Mirror the Python split heuristic
      for (const segment of String(cmd).split('" "')) {
        if (segment.includes('--app-port')) {
          const m = segment.match(/--app-port(?:=|\s+)(\d+)/i);
          if (m) port = Number(m[1]);
        }
        if (segment.includes('--install-directory')) {
          const m = segment.match(/--install-directory(?:=|\s+)(.+)$/i);
          if (m) installDir = String(m[1]).replace(/^"|"$/g, '');
        }
      }

      const cm = String(cmd).match(/loltmnt(\d+)/i);
      client = cm ? cm[1] : 'TR';
      found = true;
      break;
    }

    // Live mode: skip esports/tournament process lines and take the normal client.
    if (lower.includes('esportstmnt')) continue;

    for (const segment of String(cmd).split('" "')) {
      if (segment.includes('--app-port')) {
        const m = segment.match(/--app-port(?:=|\s+)(\d+)/i);
        if (m) port = Number(m[1]);
      }
      if (segment.includes('--install-directory')) {
        const m = segment.match(/--install-directory(?:=|\s+)(.+)$/i);
        if (m) installDir = String(m[1]).replace(/^"|"$/g, '');
      }
    }
    client = 'Live';
    found = true;
    break;
  }

  if (!found) return { installDir: null, port: null, client: null };
  return {
    installDir: installDir && String(installDir).trim() ? String(installDir).trim() : null,
    port: Number.isFinite(Number(port)) ? Number(port) : null,
    client,
  };
}

function findLockfileFromRunningClient({ live = false } = {}) {
  const { installDir } = extractDirAndPortFromCmd({ live });
  if (!installDir) return null;
  const lf = path.join(installDir, 'lockfile');
  if (fs.existsSync(lf) && fs.statSync(lf).isFile()) return lf;
  return null;
}

function* iterLockfileCandidates() {
  const envPath = process.env.LEAGUE_LOCKFILE;
  if (envPath) {
    yield envPath;
    yield path.join(envPath, 'lockfile');
  }

  if (!isWindows()) return;

  const localappdata = process.env.LOCALAPPDATA;
  const programfiles = process.env.PROGRAMFILES;
  const programfilesx86 = process.env['PROGRAMFILES(X86)'];

  const roots = [
    localappdata ? path.join(localappdata, 'Riot Games') : null,
    programfiles ? path.join(programfiles, 'Riot Games') : null,
    programfilesx86 ? path.join(programfilesx86, 'Riot Games') : null,
    'C:\\Riot Games',
    'C:\\Program Files\\Riot Games',
    'C:\\Program Files (x86)\\Riot Games',
  ].filter(Boolean);

  // Common direct locations
  for (const root of roots) {
    yield path.join(root, 'League of Legends', 'lockfile');
  }
}

function findLockfile(explicitPath, { live = false } = {}) {
  if (explicitPath) {
    const p = fs.existsSync(explicitPath) && fs.statSync(explicitPath).isDirectory()
      ? path.join(explicitPath, 'lockfile')
      : explicitPath;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    throw lcuError(`Lockfile not found at: ${p}`);
  }

  const running = findLockfileFromRunningClient({ live });
  if (running) return running;

  const seen = new Set();
  const candidates = [];
  for (const cand of iterLockfileCandidates()) {
    if (!cand || seen.has(cand)) continue;
    seen.add(cand);
    if (!fs.existsSync(cand)) continue;
    try {
      if (!fs.statSync(cand).isFile()) continue;
    } catch {
      continue;
    }

    const lower = cand.toLowerCase();
    // Skip Riot Client config lockfiles; they are not the LCU API lockfile.
    if (lower.includes('riot client') && (lower.includes('\\config\\lockfile') || lower.includes('/config/lockfile'))) {
      continue;
    }
    // Prefer League of Legends / TR client installs
    if (!lower.includes('league of legends') && !lower.includes('loltmnt')) continue;

    candidates.push(cand);
  }

  candidates.sort((a, b) => {
    const aTr = a.toLowerCase().includes('loltmnt') ? 1 : 0;
    const bTr = b.toLowerCase().includes('loltmnt') ? 1 : 0;
    return bTr - aTr;
  });

  if (candidates.length > 0) return candidates[0];

  throw lcuError('Lockfile not found. Set LEAGUE_LOCKFILE or pass lockfilePath.');
}

function withTimeout(timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs || 0)));
  return { signal: controller.signal, cancel: () => clearTimeout(t) };
}

function basicAuthHeader(username, password) {
  const token = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  return `Basic ${token}`;
}

async function lcuFetchJson({ url, timeoutMs, verifyTls, headers }) {
  try {
    const u = new URL(url);
    const isHttps = u.protocol === 'https:';
    const client = isHttps ? https : http;

    const response = await new Promise((resolve, reject) => {
      /** @type {any} */
      const options = {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port ? Number(u.port) : (isHttps ? 443 : 80),
        method: 'GET',
        path: `${u.pathname}${u.search || ''}`,
        headers,
      };

      // LCU uses a self-signed cert; mirror Python requests(verify=False)
      if (isHttps) {
        options.rejectUnauthorized = verifyTls === true;
      }

      const req = client.request(options, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > 5_000_000) {
            // Safety cap to avoid runaway memory on unexpected responses.
            req.destroy(new Error('LCU response too large'));
          }
        });
        res.on('end', () => resolve({ status: res.statusCode || 0, body }));
      });

      req.on('error', reject);

      const ms = Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : 2000;
      req.setTimeout(ms, () => {
        req.destroy(new Error(`timeout after ${ms}ms`));
      });

      req.end();
    });

    if (response.status === 404) throw lcuError('LCU API returned 404 (not in champ select or endpoint unavailable).');
    if (response.status >= 400) {
      throw lcuError(`LCU API error ${response.status}: ${String(response.body).slice(0, 300)}`);
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch {
      throw lcuError('LCU API did not return JSON.');
    }

    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
      throw lcuError('Unexpected response shape from LCU API (expected JSON object).');
    }

    return data;
  } catch (e) {
    if (e && typeof e === 'object' && e.name === 'LcuError') throw e;
    const extra = e && typeof e === 'object'
      ? (e.code ? ` code=${e.code}` : '')
      : '';
    throw lcuError(`LCU API not reachable. Tried ${url} (${e && e.name ? e.name : 'Error'}${extra}).`);
  }
}

/**
 * @param {{ lockfilePath?:string, lcuConfig?:{timeoutMs?:number, verifyTls?:boolean, protocol?:('http'|'https')|null} }} opts
 */
async function fetchChampSelectSession(opts = {}) {
  const lockfilePath = findLockfile(
    opts.lockfilePath || process.env.LEAGUE_LOCKFILE || null,
    { live: opts.live === true }
  );
  const lcuConfig = opts.lcuConfig || {};

  const contents = readLockfile(lockfilePath);
  const auth = parseLockfile(contents);

  const protocol = (lcuConfig.protocol === 'http' || lcuConfig.protocol === 'https') ? lcuConfig.protocol : auth.protocol;
  const port = auth.port;
  const url = `${protocol}://127.0.0.1:${port}/lol-champ-select/v1/session`;

  const headers = {
    Authorization: basicAuthHeader('riot', auth.password),
  };


  return await lcuFetchJson({
    url,
    timeoutMs: Number.isFinite(Number(lcuConfig.timeoutMs)) ? Number(lcuConfig.timeoutMs) : 2000,
    verifyTls: lcuConfig.verifyTls === true,
    headers,
  });
}

const DRAFT_SEQUENCE = [
  'BB1', 'RB1', 'BB2', 'RB2', 'BB3', 'RB3',
  'BP1', 'RP1', 'RP2', 'BP2', 'BP3', 'RP3',
  'RB4', 'BB4', 'RB5', 'BB5',
  'RP4', 'BP4', 'BP5', 'RP5',
];

function parseDraftSlots(champSelectSession, { championIdToName } = {}) {
  const resolveName = (cid) => {
    if (Number.isInteger(cid) && championIdToName && typeof championIdToName === 'object') {
      return championIdToName[cid] || null;
    }
    return null;
  };

  const blueBans = [];
  const redBans = [];
  const bluePicks = [];
  const redPicks = [];

  const pushAction = (a) => {
    const aType = a && typeof a === 'object' ? a.type : null;
    if (aType !== 'ban' && aType !== 'pick') return;
    if (a.completed !== true) return;

    const champId = a.championId;
    if (!Number.isInteger(champId) || champId <= 0) return;

    const isBlue = Boolean(a.isAllyAction);
    const payload = {
      championId: champId,
      championName: resolveName(champId),
      actorCellId: a.actorCellId,
      pickTurn: a.pickTurn,
    };

    if (aType === 'ban') (isBlue ? blueBans : redBans).push(payload);
    else (isBlue ? bluePicks : redPicks).push(payload);
  };

  const actions = champSelectSession && typeof champSelectSession === 'object' ? champSelectSession.actions : null;
  if (Array.isArray(actions)) {
    for (const actionGroup of actions) {
      if (!Array.isArray(actionGroup)) continue;
      const group = actionGroup.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
      group.sort((x, y) => {
        const xPickMissing = (x.pickTurn === null || x.pickTurn === undefined);
        const yPickMissing = (y.pickTurn === null || y.pickTurn === undefined);
        if (xPickMissing !== yPickMissing) return xPickMissing ? 1 : -1;

        const xPick = Number.isFinite(Number(x.pickTurn)) ? Number(x.pickTurn) : 0;
        const yPick = Number.isFinite(Number(y.pickTurn)) ? Number(y.pickTurn) : 0;
        if (xPick !== yPick) return xPick - yPick;

        const xId = Number.isFinite(Number(x.id)) ? Number(x.id) : 0;
        const yId = Number.isFinite(Number(y.id)) ? Number(y.id) : 0;
        if (xId !== yId) return xId - yId;

        const xCell = Number.isFinite(Number(x.actorCellId)) ? Number(x.actorCellId) : 0;
        const yCell = Number.isFinite(Number(y.actorCellId)) ? Number(y.actorCellId) : 0;
        return xCell - yCell;
      });
      for (const a of group) pushAction(a);
    }
  }

  const slots = Object.fromEntries(DRAFT_SEQUENCE.map((k) => [k, null]));

  const setSlot = (prefix, i, src) => {
    const idx = i - 1;
    if (idx < 0 || idx >= src.length) return;
    const champName = src[idx] && src[idx].championName;
    const champId = src[idx] && src[idx].championId;
    slots[`${prefix}${i}`] = champName || (champId !== null && champId !== undefined ? String(champId) : null);
  };

  for (let i = 1; i <= 5; i++) {
    setSlot('BB', i, blueBans);
    setSlot('RB', i, redBans);
  }
  for (let i = 1; i <= 5; i++) {
    setSlot('BP', i, bluePicks);
    setSlot('RP', i, redPicks);
  }

  return {
    sequence: [...DRAFT_SEQUENCE],
    slots,
    blueBans,
    redBans,
    bluePicks,
    redPicks,
  };
}

async function draftSlotsFromLcu({ lockfilePath, lcuConfig, championIdToName, live } = {}) {
  const session = await fetchChampSelectSession({ lockfilePath, lcuConfig, live });
  return parseDraftSlots(session, { championIdToName });
}

/**
 * Check if League Client is running and lockfile is accessible.
 * @param {{ lockfilePath?: string, live?: boolean }} opts
 * @returns {Promise<{ found: boolean, path: string | null, error: string | null }>}
 */
async function isClientUp(opts = {}) {
  try {
    const path = findLockfile(opts.lockfilePath || process.env.LEAGUE_LOCKFILE || null, { live: opts.live === true });
    return { found: true, path, error: null };
  } catch (e) {
    return { found: false, path: null, error: String(e && e.message ? e.message : e) };
  }
}

/**
 * Get the current gameflow phase (e.g., "ChampSelect", "InProgress", "EndOfGame").
 * @param {{ lockfilePath?: string, lcuConfig?: any }} opts
 * @returns {Promise<string | null>}
 */
async function getGameflowPhase(opts = {}) {
  try {
    const lockfilePath = findLockfile(
      opts.lockfilePath || process.env.LEAGUE_LOCKFILE || null,
      { live: opts.live === true }
    );
    const contents = readLockfile(lockfilePath);
    const auth = parseLockfile(contents);

    const protocol = (opts.lcuConfig?.protocol === 'http' || opts.lcuConfig?.protocol === 'https') ? opts.lcuConfig.protocol : auth.protocol;
    const url = `${protocol}://127.0.0.1:${auth.port}/lol-gameflow/v1/gameflow-phase`;

    const headers = {
      Authorization: basicAuthHeader('riot', auth.password),
    };

    const phase = await lcuFetchJson({
      url,
      timeoutMs: opts.lcuConfig?.timeoutMs || 1500,
      verifyTls: opts.lcuConfig?.verifyTls === true,
      headers,
    });

    return typeof phase === 'string' ? phase : null;
  } catch {
    return null;
  }
}

async function extractMetadata(champSelectSession, { lockfilePath, lcuAuth } = {}) {
  /**
   * Extract game metadata from champ select session and LCU config.
   * Returns: { side, patch, oppositeTeam, tr, date }
   */
  const metadata = {
    side: null,
    patch: null,
    oppositeTeam: null,
    tr: false,
    date: new Date().toISOString().split('T')[0],
  };

  if (!champSelectSession || typeof champSelectSession !== 'object') return metadata;

  // Extract side (BLUE/RED) from localPlayerCellId
  const cellId = champSelectSession.localPlayerCellId;
  if (Number.isFinite(Number(cellId))) {
    metadata.side = Number(cellId) < 5 ? 'BLUE' : 'RED';
  }

  // Extract opposite team names from myTeam/theirTeam
  try {
    const myTeam = champSelectSession.myTeam || [];
    const theirTeam = champSelectSession.theirTeam || [];

    if (Array.isArray(theirTeam) && theirTeam.length > 0) {
      const oppositeNames = theirTeam
        .map((p) => (typeof p?.summonerName === 'string' ? p.summonerName.trim() : null))
        .filter(Boolean);
      if (oppositeNames.length > 0) {
        metadata.oppositeTeam = oppositeNames.join(', ');
      }
    }
  } catch {
    // Ignore errors when extracting team names
  }

  // Extract patch from LCU config
  if (lcuAuth && lockfilePath) {
    try {
      const { protocol, port, password } = lcuAuth;
      const url = `${protocol}://127.0.0.1:${port}/lol-client-config/v3/install-settings`;
      const auth = basicAuthHeader('riot', password);
      const config = await lcuFetchJson({
        url,
        headers: { Authorization: auth },
        timeoutMs: 1500,
        verifyTls: false,
      });

      if (config && typeof config === 'object') {
        const patchVersion = config.install_settings?.patch_version || config.patchVersion || null;
        if (patchVersion) metadata.patch = String(patchVersion);
      }
    } catch {
      // Ignore errors when fetching patch
    }
  }

  // Detect Tournament Realm by checking LeagueClientUx process command line
  try {
    const cmdlines = powershellGetLeagueClientUxCmdlines();
    for (const cmd of cmdlines) {
      if (String(cmd).toLowerCase().includes('loltmnt')) {
        metadata.tr = true;
        break;
      }
    }
  } catch {
    // Ignore errors when checking for TR
  }

  return metadata;
}

function extractIngameRoleMapping(allGameData) {
  const players = allGameData && typeof allGameData === 'object' ? allGameData.allPlayers : null;
  if (!Array.isArray(players)) return { BLUE: {}, RED: {} };

  const teamColor = (team) => {
    if (team === 'ORDER') return 'BLUE';
    if (team === 'CHAOS') return 'RED';
    return null;
  };

  const normRole = (pos) => {
    if (typeof pos !== 'string' || !pos) return null;
    const v = pos.trim().toUpperCase();
    const mapping = {
      TOP: 'TOP',
      JUNGLE: 'JUNGLE',
      MIDDLE: 'MID',
      MID: 'MID',
      BOTTOM: 'BOT',
      BOT: 'BOT',
      UTILITY: 'SUP',
      SUPPORT: 'SUP',
    };
    return mapping[v] || null;
  };

  const hasSmite = (p) => {
    const spells = p && typeof p === 'object' ? p.summonerSpells : null;
    if (!spells || typeof spells !== 'object') return false;
    for (const key of ['summonerSpellOne', 'summonerSpellTwo']) {
      const s = spells[key];
      const name = s && typeof s === 'object' ? s.displayName : null;
      if (typeof name === 'string' && name.toLowerCase().includes('smite')) return true;
    }
    return false;
  };

  const SUPPORT_ITEM_IDS = new Set([
    3865, 3866, 3867, 3869, // World Atlas line
    3850, 3851, 3854, 3855, // older starters
  ]);

  const hasSupportItem = (p) => {
    const items = p && typeof p === 'object' ? p.items : null;
    if (!Array.isArray(items)) return false;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      const iid = it.itemID;
      if (Number.isInteger(iid) && SUPPORT_ITEM_IDS.has(iid)) return true;
    }
    return false;
  };

  const hasTeleport = (p) => {
    const spells = p && typeof p === 'object' ? p.summonerSpells : null;
    if (!spells || typeof spells !== 'object') return false;
    for (const key of ['summonerSpellOne', 'summonerSpellTwo']) {
      const s = spells[key];
      const name = s && typeof s === 'object' ? s.displayName : null;
      if (typeof name === 'string' && name.toLowerCase().includes('teleport')) return true;
    }
    return false;
  };

  const creepScore = (p) => {
    const scores = p && typeof p === 'object' ? p.scores : null;
    const cs = scores && typeof scores === 'object' ? scores.creepScore : 0;
    return (Number.isFinite(cs) ? Math.trunc(cs) : 0);
  };

  // First try the official position if it exists (not NONE)
  const out = { BLUE: {}, RED: {} };
  let anyPosition = false;

  for (const p of players) {
    if (!p || typeof p !== 'object') continue;
    const role = normRole(p.position);
    if (role !== null) {
      anyPosition = true;
      const color = teamColor(p.team);
      const champ = p.championName;
      if (color && typeof champ === 'string' && champ) {
        out[color][role] = champ;
      }
    }
  }

  if (anyPosition) return out;

  // Heuristics fallback when position is NONE for all players.
  const assignTeam = (teamName, color) => {
    const teamPlayers = players.filter((p) => p && typeof p === 'object' && p.team === teamName);
    if (teamPlayers.length === 0) return;

    let remaining = [...teamPlayers];

    // JUNGLE: Smite
    const junglers = remaining.filter((p) => hasSmite(p));
    if (junglers.length > 0) {
      let best = junglers[0];
      for (const j of junglers) if (creepScore(j) > creepScore(best)) best = j;
      out[color].JUNGLE = best.championName;
      remaining = remaining.filter((p) => p !== best);
    }

    // SUP: support item, otherwise lowest CS
    const supports = remaining.filter((p) => hasSupportItem(p));
    let s = null;
    if (supports.length > 0) {
      s = supports.reduce((acc, cur) => (creepScore(cur) < creepScore(acc) ? cur : acc), supports[0]);
    } else if (remaining.length > 0) {
      s = remaining.reduce((acc, cur) => (creepScore(cur) < creepScore(acc) ? cur : acc), remaining[0]);
    }

    if (s) {
      out[color].SUP = s.championName;
      remaining = remaining.filter((p) => p !== s);
    }

    // BOT: prefer non-TP highest CS (usually ADC)
    const nonTp = remaining.filter((p) => !hasTeleport(p));
    let b = null;
    if (nonTp.length > 0) {
      b = nonTp.reduce((acc, cur) => (creepScore(cur) > creepScore(acc) ? cur : acc), nonTp[0]);
    } else if (remaining.length > 0) {
      b = remaining.reduce((acc, cur) => (creepScore(cur) > creepScore(acc) ? cur : acc), remaining[0]);
    }

    if (b) {
      out[color].BOT = b.championName;
      remaining = remaining.filter((p) => p !== b);
    }

    // Remaining two: MID vs TOP by CS (higher -> MID)
    if (remaining.length >= 2) {
      remaining.sort((a, b) => creepScore(b) - creepScore(a));
      out[color].MID = remaining[0].championName;
      out[color].TOP = remaining[1].championName;
    } else if (remaining.length === 1) {
      out[color].MID = remaining[0].championName;
    }
  };

  assignTeam('ORDER', 'BLUE');
  assignTeam('CHAOS', 'RED');

  // Stable keys
  for (const c of ['BLUE', 'RED']) {
    for (const r of ['TOP', 'JUNGLE', 'MID', 'BOT', 'SUP']) {
      if (!Object.prototype.hasOwnProperty.call(out[c], r)) out[c][r] = null;
    }
  }

  return out;
}

export {
  DRAFT_SEQUENCE,
  parseLockfile,
  findLockfile,
  parseDraftSlots,
  fetchChampSelectSession,
  draftSlotsFromLcu,
  extractIngameRoleMapping,
  extractMetadata,
  isClientUp,
  getGameflowPhase,
};

export const debug = {
  extractDirAndPortFromCmd,
  powershellGetLeagueClientUxCmdlines,
};

export const errors = {
  lcuError,
  liveClientError,
};

export default {
  DRAFT_SEQUENCE,
  parseLockfile,
  findLockfile,
  parseDraftSlots,
  fetchChampSelectSession,
  draftSlotsFromLcu,
  extractIngameRoleMapping,
  extractMetadata,
  isClientUp,
  getGameflowPhase,
  debug,
  errors,
};
