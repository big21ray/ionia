import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFile } from 'node:child_process';

// Small helper to wait between polls.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs a PowerShell command and returns stdout/stderr.
// We use PowerShell here because it's the easiest way on Windows to query the
// command line of a running process (LeagueClientUx.exe).
const execPowerShell = async (command, timeoutMs = 2000) => {
  return await new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(Object.assign(err, { stdout: String(stdout || ''), stderr: String(stderr || '') }));
          return;
        }
        resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
  });
};

const getLeagueClientProcesses = async () => {
  // Returns one entry per LeagueClientUx.exe process.
  // We pull *both* CommandLine and ExecutablePath so we can filter Tournament Realm
  // the same way your Python code intends:
  // - Python LCU._get_cmd_args(): checks "loltmnt" in the CommandLine
  // - Python OBS window filter: checks "loltmnt" in the exe path
  // Here we support either.
  const ps =
    "(Get-CimInstance Win32_Process -Filter \"Name='LeagueClientUx.exe'\" | Select-Object CommandLine, ExecutablePath | ConvertTo-Json -Compress)";
  const { stdout } = await execPowerShell(ps);

  const trimmed = stdout.trim();
  if (!trimmed) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return arr
    .map((p) => ({
      cmdLine: String(p?.CommandLine || '').trim(),
      exePath: String(p?.ExecutablePath || '').trim(),
    }))
    .filter((p) => p.cmdLine || p.exePath);
};

const parseInstallDirAndPort = (cmdLine) => {
  // Extract two values from the League client command line:
  // - installDirectory: where to find the lockfile
  // - port: used by the local LCU API
  const installMatch = /--install-directory=([^\s\"]+|\"[^\"]+\")/i.exec(cmdLine);
  const portMatch = /--app-port=(\d+)/i.exec(cmdLine);
  if (!installMatch || !portMatch) return null;

  const rawInstall = installMatch[1];
  const installDirectory = rawInstall.startsWith('"') && rawInstall.endsWith('"')
    ? rawInstall.slice(1, -1)
    : rawInstall;

  const port = Number(portMatch[1]);
  if (!installDirectory || !Number.isFinite(port) || port <= 0) return null;
  return { installDirectory, port };
};

const readLockfile = (installDirectory) => {
  // The lockfile format is:
  //   processName:pid:port:password:protocol
  // Example:
  //   LeagueClientUx:12345:62245:somePassword:https
  // We need the port and password to authenticate to the LCU HTTPS API.
  const lockfilePath = path.join(installDirectory, 'lockfile');
  if (!fs.existsSync(lockfilePath)) return null;

  const content = fs.readFileSync(lockfilePath, 'utf8').trim();
  const parts = content.split(':');
  // process:pid:port:password:protocol
  if (parts.length < 5) return null;

  const port = Number(parts[2]);
  const password = parts[3];
  if (!Number.isFinite(port) || port <= 0 || !password) return null;
  return { port, password };
};

const lcuGet = async ({ port, password }, endpoint, timeoutMs = 1000) => {
  // LCU API uses HTTPS on localhost with a self-signed cert.
  // Auth is HTTP Basic with username "riot" and password from the lockfile.
  // Node's https can talk to it if we set rejectUnauthorized=false.
  const auth = Buffer.from(`riot:${password}`, 'utf8').toString('base64');
  const url = `https://127.0.0.1:${port}${endpoint}`;

  return await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Basic ${auth}`,
        },
        rejectUnauthorized: false,
        timeout: timeoutMs,
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => {
          if ((res.statusCode || 0) >= 400) {
            reject(new Error(`HTTP ${res.statusCode} for ${endpoint}`));
            return;
          }
          try {
            // Most LCU endpoints return JSON.
            resolve(body ? JSON.parse(body) : null);
          } catch {
            // If it's not JSON, return the raw body.
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

const getLcuConnection = async () => {
  // Step 1: Find the League client process.
  // Step 2: Parse install directory from its command line.
  // Step 3: Read lockfile to get the current password (and sometimes updated port).
  //
  // This mirrors the Python approach: loop until a usable lockfile is available.
  // In practice, the lockfile may briefly not exist (client starting) or be in flux.
  const procs = await getLeagueClientProcesses();
  if (procs.length === 0) return null;

  // Tournament Realm preference: pick a process where "loltmnt" appears either
  // in the full executable path or in the command line.
  const tr = procs.filter((p) => `${p.exePath} ${p.cmdLine}`.toLowerCase().includes('loltmnt'));
  const candidates = tr.length > 0 ? tr : procs;

  // Prefer a process whose command line includes both flags, but still fall back.
  const orderedCandidates = [...candidates].sort((a, b) => {
    const aHas = a.cmdLine.includes('--install-directory=') && a.cmdLine.includes('--app-port=');
    const bHas = b.cmdLine.includes('--install-directory=') && b.cmdLine.includes('--app-port=');
    return Number(bHas) - Number(aHas);
  });

  // Python does this kind of logic by repeatedly checking until the TR client is ready.
  // Here we:
  // - loop over candidates
  // - parse install dir
  // - retry reading the lockfile a few times (short sleep) before moving on
  for (const candidate of orderedCandidates) {
    const parsed = parseInstallDirAndPort(candidate.cmdLine);
    if (!parsed) continue;

    let lock = null;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      lock = readLockfile(parsed.installDirectory);
      if (lock) break;
      await sleep(200);
    }
    if (!lock) continue;

    return {
      installDirectory: parsed.installDirectory,
      port: lock.port,
      password: lock.password,
    };
  }

  return null;
};

const getGameflowPhase = async () => {
  // /lol-gameflow/v1/gameflow-phase is a very convenient endpoint.
  // It returns a string like:
  //   "None", "Lobby", "Matchmaking", "ChampSelect", "InProgress", "EndOfGame", ...
  // We use it to detect "game started" and other states.
  const conn = await getLcuConnection();
  if (!conn) return null;

  try {
    const phase = await lcuGet(conn, '/lol-gameflow/v1/gameflow-phase');
    return typeof phase === 'string' ? phase : null;
  } catch {
    return null;
  }
};

const formatStatus = (phase) => {
  // Convert raw phase string into boolean flags that are easy to reason about.
  // Note: This is *not* the same as the Live Client API (2999). This is the LCU
  // (the client) and lets you detect Champ Select before the match actually starts.
  const inSession = Boolean(phase && phase !== 'None');
  const inChampSelect = phase === 'ChampSelect';
  const inGame = phase === 'InProgress';
  return { phase, inSession, inChampSelect, inGame };
};

const parseArgs = () => {
  // CLI flags:
  //   --once           : run a single check and exit
  //   --interval=2000  : poll interval in milliseconds (when not using --once)
  const args = process.argv.slice(2);
  const once = args.includes('--once');

  let intervalMs = 2000;
  const intervalArg = args.find((a) => a.startsWith('--interval='));
  if (intervalArg) {
    const value = Number(intervalArg.split('=')[1]);
    if (Number.isFinite(value) && value >= 250) intervalMs = value;
  }

  return { once, intervalMs };
};

const main = async () => {
  const { once, intervalMs } = parseArgs();

  let lastPrinted = null;
  let warnedNonTr = false;

  while (true) {
    const phase = await getGameflowPhase();
    const status = formatStatus(phase);

    if (!warnedNonTr) {
      try {
        const procs = await getLeagueClientProcesses();
        const hasTr = procs.some((p) => `${p.exePath} ${p.cmdLine}`.toLowerCase().includes('loltmnt'));
        if (procs.length > 0 && !hasTr) {
          warnedNonTr = true;
          console.log('[note] No "loltmnt" detected in LeagueClientUx.exe path/args; using the first available client.');
        }
      } catch {
        // ignore
      }
    }

    const key = JSON.stringify(status);
    if (key !== lastPrinted) {
      lastPrinted = key;
      const ts = new Date().toISOString();
      // Only prints when something changes, to keep the output readable.
      console.log(`[${ts}] phase=${status.phase ?? 'null'} inSession=${status.inSession} inChampSelect=${status.inChampSelect} inGame=${status.inGame}`);
    }

    if (once) break;
    await sleep(intervalMs);
  }
};

main().catch((err) => {
  console.error('lol_lcu_watch failed:', err);
  process.exitCode = 1;
});
