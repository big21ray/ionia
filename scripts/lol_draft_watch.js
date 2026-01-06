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
} from './lol_lcu_watch.js';

const DEFAULT_INTERVAL_MS = 10_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  if (Array.isArray(data)) {
    for (const champ of data) {
      const id = Number(champ?.id);
      if (!Number.isFinite(id) || id <= 0) continue;

      // Prefer the human-readable name (e.g., "Lee Sin").
      const alias = typeof champ?.alias === 'string' ? champ.alias.trim() : '';
      const name = typeof champ?.name === 'string' ? champ.name.trim() : '';
      map[id] = name || alias || String(id);
    }
  }

  cachedChampionIdToName = map;
  return map;
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

  let lockfilePath;
  try {
    lockfilePath = findLockfile(process.env.LEAGUE_LOCKFILE || null, { live: false });
  } catch {
    console.log('[lol_draft_watch] No LeagueClientUx.exe / lockfile found.');
    process.exitCode = 2;
    return;
  }

  let lastKey = null;

  while (true) {
    const ts = new Date().toISOString();
    const phase = await getGameflowPhase({ lockfilePath });

    if (phase !== 'ChampSelect') {
      const key = `phase=${phase ?? 'null'}`;
      // Requested behavior: print every interval even if unchanged.
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
      const v = slots[k];
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
