/**
 * lol_game_watcher.js
 * 
 * Polls League Client for gameflow phase changes and reports events to backend API.
 * Tracks: ChampSelect → InProgress → EndOfGame lifecycle.
 * 
 * Requires BEARER_TOKEN env var (from /activate endpoint).
 * Optional: BACKEND_URL (default: http://127.0.0.1:8000)
 */

import * as http from 'node:http';
import * as https from 'node:https';

import {
  isClientUp,
  getGameflowPhase,
  fetchChampSelectSession,
  extractMetadata,
  parseLockfile,
  readLockfile,
  DRAFT_SEQUENCE,
  parseDraftSlots,
} from './lol_lcu_watch.js';

const BACKEND_URL = process.env.BACKEND_URL || 'http://127.0.0.1:8000';
const BEARER_TOKEN = process.env.BEARER_TOKEN || '';
const POLL_INTERVAL_MS = 2000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!BEARER_TOKEN) {
  console.warn('[lol_game_watcher] WARNING: BEARER_TOKEN not set. API calls will fail.');
}

/**
 * POST request to backend API.
 */
async function postToBackend(endpoint, payload) {
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
}

/**
 * Main watcher loop.
 */
async function main() {
  console.log('[lol_game_watcher] Starting...');
  console.log(`[lol_game_watcher] Backend: ${BACKEND_URL}`);
  if (!BEARER_TOKEN) {
    console.error('[lol_game_watcher] ERROR: BEARER_TOKEN is required. Exiting.');
    process.exit(1);
  }

  let lastPhase = null;
  let lockfilePath = null;
  let activeGameId = null;
  let lastDraftSlots = null;

  while (true) {
    // Check if client is up
    const { found, path } = await isClientUp({ live: false });
    if (!found) {
      if (lastPhase !== null) {
        console.log('[lol_game_watcher] Client disconnected.');
        lastPhase = null;
        activeGameId = null;
        lastDraftSlots = null;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    lockfilePath = path;

    // Get current phase
    const phase = await getGameflowPhase({ lockfilePath, live: false });
    if (!phase) {
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    // Log phase transitions
    if (phase !== lastPhase) {
      console.log(`[lol_game_watcher] Phase: ${lastPhase} → ${phase}`);

      // Handle phase transitions
      if (phase === 'ChampSelect' && lastPhase !== 'ChampSelect') {
        const result = await handleChampSelectStart(lockfilePath);
        if (result?.game_id) {
          activeGameId = result.game_id;
        }
      } else if (phase === 'InProgress' && lastPhase !== 'InProgress') {
        if (activeGameId) {
          await handleGameStart(lockfilePath, activeGameId);
        }
      } else if (phase === 'EndOfGame' && lastPhase !== 'EndOfGame') {
        if (activeGameId) {
          await handleGameEnd(lockfilePath, activeGameId);
        }
        activeGameId = null;
        lastDraftSlots = null;
      }

      lastPhase = phase;
    }

    // While in ChampSelect, poll for draft updates
    if (phase === 'ChampSelect' && activeGameId) {
      try {
        const session = await fetchChampSelectSession({ lockfilePath, live: false });
        const draftSlots = parseDraftSlots(session, {});

        const currentDraft = draftSlots.slots;
        // Check if draft changed
        if (lastDraftSlots !== JSON.stringify(currentDraft)) {
          await handleDraftComplete(activeGameId, currentDraft);
          lastDraftSlots = JSON.stringify(currentDraft);
        }
      } catch (err) {
        // Ignore draft polling errors
      }
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

async function handleChampSelectStart(lockfilePath) {
  console.log('[lol_game_watcher] ChampSelect started, extracting metadata...');
  try {
    const session = await fetchChampSelectSession({ lockfilePath, live: false });
    const contents = readLockfile(lockfilePath);
    const auth = parseLockfile(contents);
    const metadata = await extractMetadata(session, { lockfilePath, lcuAuth: auth });

    console.log('[lol_game_watcher] Metadata:', metadata);

    // POST to backend: /events/champ_select_start
    const payload = {
      date: metadata.date,
      opposite_team: metadata.oppositeTeam || 'Unknown',
      patch: metadata.patch || 'Unknown',
      tr: metadata.tr ? 'true' : 'false',
      side: metadata.side || 'UNKNOWN',
    };

    console.log('[lol_game_watcher] POST /events/champ_select_start:', JSON.stringify(payload));
    const response = await postToBackend('/events/champ_select_start', payload);
    console.log('[lol_game_watcher] ChampSelect response:', response);
    return response;
  } catch (err) {
    console.error('[lol_game_watcher] Error in ChampSelect:', err.message);
    return null;
  }
}

async function handleDraftComplete(gameId, draftSlots) {
  console.log('[lol_game_watcher] Draft updated, posting to /events/draft_complete...');
  try {
    const payload = {
      game_id: gameId,
      draft: draftSlots,
    };

    console.log('[lol_game_watcher] POST /events/draft_complete:', JSON.stringify(payload).slice(0, 200) + '...');
    const response = await postToBackend('/events/draft_complete', payload);
    console.log('[lol_game_watcher] Draft response:', response);
  } catch (err) {
    console.error('[lol_game_watcher] Error posting draft:', err.message);
  }
}

async function handleGameStart(lockfilePath, gameId) {
  console.log('[lol_game_watcher] Game started (InProgress), posting to /events/game_start...');
  try {
    // TODO: Fetch game data from Live Client API for positions if available
    const payload = {
      game_id: gameId,
      positions: {
        // BT, BJ, BM, BA, BS, RT, RJ, RM, RA, RS
        // Will be populated from Live Client API or in-game data
      },
    };

    console.log('[lol_game_watcher] POST /events/game_start:', JSON.stringify(payload));
    const response = await postToBackend('/events/game_start', payload);
    console.log('[lol_game_watcher] GameStart response:', response);
  } catch (err) {
    console.error('[lol_game_watcher] Error in GameStart:', err.message);
  }
}

async function handleGameEnd(lockfilePath, gameId) {
  console.log('[lol_game_watcher] Game ended (EndOfGame), posting to /events/game_finished...');
  try {
    // TODO: Fetch win/loss result from Live Client API
    const payload = {
      game_id: gameId,
      win: 'W', // or 'L' - fetch from Live Client API
    };

    console.log('[lol_game_watcher] POST /events/game_finished:', JSON.stringify(payload));
    const response = await postToBackend('/events/game_finished', payload);
    console.log('[lol_game_watcher] GameEnd response:', response);
  } catch (err) {
    console.error('[lol_game_watcher] Error in GameEnd:', err.message);
  }
}

main().catch(console.error);
