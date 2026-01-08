import * as fs from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';

// Reuse the LCU + draft parsing logic from lol_lcu_watch.js
import {
  DRAFT_SEQUENCE,
  findLockfile,
  parseLockfile,
  fetchChampSelectSession,
  parseDraftSlots,
  extractMetadata,
  readLockfile,
  getGameflowPhase,
} from './lol_lcu_watch.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const BEARER_TOKEN = process.env.BEARER_TOKEN || '';
const DEFAULT_INTERVAL_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BEARER_TOKEN) {
  console.warn('[lol_draft_watch] WARNING: BEARER_TOKEN not set. API calls will fail.');
}

const requestJson = async ({ url, headers, timeoutMs = 2000, verifyTls = false }) => {
  const lib = url.startsWith('https:') ? https : http;
  return await new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers,
        timeout: timeoutMs,
        rejectUnauthorized: verifyTls,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            return;
          }
          try {
            resolve(body ? JSON.parse(body) : null);
          } catch {
            resolve(body);
          }
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
    req.on('error', reject);
    req.end();
  });
};

/**
 * POST request to backend API.
 */
const postToBackend = async (endpoint, payload) => {
  return new Promise((resolve, reject) => {
    const url = new URL(`${BACKEND_URL}${endpoint}`);
    const lib = url.protocol === 'https:' ? https : http;

    const body = JSON.stringify(payload);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 5000,
    };

    if (BEARER_TOKEN) {
      options.headers.Authorization = `Bearer ${BEARER_TOKEN}`;
    }

    const req = lib.request(url, options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        const status = res.statusCode || 0;
        if (status >= 400) {
          reject(new Error(`HTTP ${status}: ${data}`));
        } else {
          try {
            resolve(data ? JSON.parse(data) : null);
          } catch {
            resolve(data);
          }
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
};
  });
};

const basicAuthHeader = (user, pass) => {
  const token = Buffer.from(`${user}:${pass}`, 'utf8').toString('base64');
  return `Basic ${token}`;
};

const getLcuAuthFromLockfilePath = (lockfilePath) => {
  const contents = fs.readFileSync(lockfilePath, 'utf8');
  return parseLockfile(contents);
};

let cachedChampionIdToName = null;
const loadChampionIdToName = async ({ lockfilePath }) => {
  if (cachedChampionIdToName) return cachedChampionIdToName;

  const auth = getLcuAuthFromLockfilePath(lockfilePath);
  const protocol = auth.protocol;
  const url = `${protocol}://127.0.0.1:${auth.port}/lol-game-data/assets/v1/champions.json`;
  const data = await requestJson({
    url,
    headers: { Authorization: basicAuthHeader('riot', auth.password) },
    timeoutMs: 3000,
    verifyTls: false,
  });

  const map = Object.create(null);

  // LCU `champions.json` shape differs across builds. Handle common variants:
  // - Array of champions
  // - { champions: [...] }
  // - { data: [...] }
  // - Object map keyed by id/alias
  let champs = null;
  if (Array.isArray(data)) champs = data;
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.champions)) champs = data.champions;
    else if (Array.isArray(data.data)) champs = data.data;
    else champs = Object.values(data);
  }

  if (Array.isArray(champs)) {
    for (const champ of champs) {
      const id = Number(champ?.id);
      if (!Number.isFinite(id) || id <= 0) continue;

      // Prefer the human-readable name (e.g., "Lee Sin").
      const alias = typeof champ?.alias === 'string' ? champ.alias.trim() : '';
      const name = typeof champ?.name === 'string' ? champ.name.trim() : '';
      const label = name || alias;
      if (label) map[id] = label;
    }
  }

  cachedChampionIdToName = map;
  return map;
};

// Fallback: resolve a single champion id to a readable name.
// This is used when the bulk mapping endpoint doesn't return the expected shape.
const championNameCache = new Map();
const getChampionNameById = async ({ lockfilePath, championId }) => {
  const id = Number(championId);
  if (!Number.isFinite(id) || id <= 0) return null;

  if (championNameCache.has(id)) return championNameCache.get(id);

  const auth = getLcuAuthFromLockfilePath(lockfilePath);
  const url = `${auth.protocol}://127.0.0.1:${auth.port}/lol-game-data/assets/v1/champions/${id}.json`;
  try {
    const champ = await requestJson({
      url,
      headers: { Authorization: basicAuthHeader('riot', auth.password) },
      timeoutMs: 1500,
      verifyTls: false,
    });

    const alias = typeof champ?.alias === 'string' ? champ.alias.trim() : '';
    const name = typeof champ?.name === 'string' ? champ.name.trim() : '';
    const label = name || alias || null;

    championNameCache.set(id, label);
    return label;
  } catch {
    championNameCache.set(id, null);
    return null;
  }
};

const getGameflowPhase = async ({ lockfilePath }) => {
  const auth = getLcuAuthFromLockfilePath(lockfilePath);
  const url = `${auth.protocol}://127.0.0.1:${auth.port}/lol-gameflow/v1/gameflow-phase`;
  try {
    const phase = await requestJson({
      url,
      headers: { Authorization: basicAuthHeader('riot', auth.password) },
      timeoutMs: 1500,
      verifyTls: false,
    });
    return typeof phase === 'string' ? phase : null;
  } catch {
    return null;
  }
};

const parseArgs = () => {
  const args = process.argv.slice(2);

  let intervalMs = DEFAULT_INTERVAL_MS;
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  if (intervalArg) {
    const v = Number(intervalArg.split('=')[1]);
    if (Number.isFinite(v) && v >= 1000) intervalMs = v;
  }

  const once = args.includes('--once');
  const showFull = args.includes('--full');

  return { intervalMs, once, showFull };
};

const main = async () => {
  const { intervalMs, once, showFull } = parseArgs();

  if (!BEARER_TOKEN) {
    console.error('[lol_draft_watch] ERROR: BEARER_TOKEN is required. Exiting.');
    process.exitCode = 1;
    return;
  }

  let lockfilePath;
  try {
    lockfilePath = findLockfile(process.env.LEAGUE_LOCKFILE || null, { live: false });
  } catch {
    console.log('[lol_draft_watch] No LeagueClientUx.exe / lockfile found.');
    process.exitCode = 2;
    return;
  }

  let lastKey = null;
  let activeGameId = null;
  let lastDraftJson = null;

  while (true) {
    const ts = new Date().toISOString();
    const phase = await getGameflowPhase({ lockfilePath });

    // Handle phase transitions
    if (phase === 'ChampSelect' && !activeGameId) {
      // ChampSelect started - initialize game
      try {
        const session = await fetchChampSelectSession({ lockfilePath, live: false });
        const contents = readLockfile(lockfilePath);
        const auth = parseLockfile(contents);
        const metadata = await extractMetadata(session, { lockfilePath, lcuAuth: auth });

        const payload = {
          date: metadata.date,
          opposite_team: metadata.oppositeTeam || 'Unknown',
          patch: metadata.patch || 'Unknown',
          tr: metadata.tr ? 'true' : 'false',
          side: metadata.side || 'UNKNOWN',
        };

        console.log(`[${ts}] POST /events/champ_select_start`);
        const response = await postToBackend('/events/champ_select_start', payload);
        activeGameId = response?.game_id;
        console.log(`[${ts}] game_id=${activeGameId}`);
      } catch (err) {
        console.error(`[${ts}] Error starting game:`, err.message);
      }
    } else if (phase !== 'ChampSelect' && activeGameId) {
      // Left ChampSelect phase
      if (phase === 'InProgress') {
        // Game started
        try {
          const payload = {
            game_id: activeGameId,
            positions: {},
          };
          console.log(`[${ts}] POST /events/game_start (game_id=${activeGameId})`);
          await postToBackend('/events/game_start', payload);
        } catch (err) {
          console.error(`[${ts}] Error posting game_start:`, err.message);
        }
      } else if (phase === 'EndOfGame') {
        // Game ended
        try {
          const payload = {
            game_id: activeGameId,
            win: 'W',
          };
          console.log(`[${ts}] POST /events/game_finished (game_id=${activeGameId})`);
          await postToBackend('/events/game_finished', payload);
        } catch (err) {
          console.error(`[${ts}] Error posting game_finished:`, err.message);
        }
        activeGameId = null;
        lastDraftJson = null;
      }
    }

    if (phase !== 'ChampSelect') {
      const key = `phase=${phase ?? 'null'}`;
      lastKey = key;
      console.log(`[${ts}] phase=${phase ?? 'null'} (not in champ select)`);

      if (once) break;
      await sleep(intervalMs);
      continue;
    }

    const session = await fetchChampSelectSession({ lockfilePath, live: false });
    if (!session) {
      const key = 'phase=ChampSelect session=null';
      lastKey = key;
      console.log(`[${ts}] phase=ChampSelect (session unavailable yet)`);

      if (once) break;
      await sleep(intervalMs);
      continue;
    }

    let championIdToName = null;
    try {
      championIdToName = await loadChampionIdToName({ lockfilePath });
    } catch {
      championIdToName = null;
    }

    const parsed = parseDraftSlots(session, { championIdToName });
    const slots = parsed?.slots && typeof parsed.slots === 'object' ? parsed.slots : {};

    // Post draft updates if there's an active game
    if (activeGameId) {
      const currentDraftJson = JSON.stringify(slots);
      if (lastDraftJson !== currentDraftJson) {
        try {
          const payload = {
            game_id: activeGameId,
            draft: slots,
          };
          console.log(`[${ts}] POST /events/draft_complete (game_id=${activeGameId})`);
          await postToBackend('/events/draft_complete', payload);
          lastDraftJson = currentDraftJson;
        } catch (err) {
          console.error(`[${ts}] Error posting draft_complete:`, err.message);
        }
      }
    }

    // Champ select timer state (when present) can indicate FINALIZATION.
    const timerPhase = session?.timer?.phase ? String(session.timer.phase) : null;
    const isFinalization = timerPhase && timerPhase.toUpperCase() === 'FINALIZATION';

    // Determine current draft step by finding the first slot in the official sequence
    // that is still empty (null). This approximates "we are on RP3" etc.
    let step = 'done';
    for (const k of DRAFT_SEQUENCE) {
      if (slots[k] === null) {
        step = k;
        break;
      }
    }

    // Requirement: print the full draft output on every log.
    // We always render the full DRAFT_SEQUENCE (completed and future slots).
    const rendered = [];
    for (const k of DRAFT_SEQUENCE) {
      let v = slots[k];

      // If parsing couldn't resolve a name, it falls back to the numeric id as a string.
      // Convert that to a champion name via per-id lookup.
      if (typeof v === 'string' && /^\d+$/.test(v)) {
        const resolved = await getChampionNameById({ lockfilePath, championId: Number(v) });
        if (resolved) v = resolved;
      }

      rendered.push(`${k}=${v || '-'}`);
    }

    lastKey = `step=${step}`;
    console.log(`[${ts}] step=${step}${timerPhase ? ` state=${timerPhase}` : ''} ${rendered.join(' ')}`);

    // Requirement: once we reach FINALIZATION, print "waiting for the game starts" once and exit.
    if (isFinalization) {
      console.log(`[${ts}] waiting for the game starts`);
      break;
    }

    if (once) break;
    await sleep(intervalMs);
  }
};

main().catch((err) => {
  console.error('lol_draft_watch failed:', err);
  process.exitCode = 1;
});
