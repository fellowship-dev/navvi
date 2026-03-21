#!/usr/bin/env node
/**
 * Navvi MCP Server v0.5.0 — local + remote browser automation.
 *
 * Lifecycle:
 *   navvi_start (local|remote), navvi_stop, navvi_status, navvi_list
 *
 * Browser control (PinchTab):
 *   navvi_up, navvi_down, navvi_open, navvi_inspect,
 *   navvi_click, navvi_fill, navvi_screenshot
 *
 * Video recording:
 *   navvi_record_start, navvi_record_stop, navvi_record_gif
 *
 * Speaks MCP stdio protocol. Zero dependencies (Node built-ins only).
 */

import http from 'http';
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

const REPO = process.env.NAVVI_REPO || 'Fellowship-dev/navvi';
const MACHINE_TYPE = process.env.NAVVI_MACHINE || 'basicLinux32gb';
const PINCHTAB_PORT = 9867;
const PIDFILE_FWD = path.join(os.tmpdir(), '.navvi-port-forward.pid');
const PIDFILE_LOCAL = path.join(os.tmpdir(), '.navvi-pinchtab-local.pid');
const PIDFILE_RECORD = path.join(os.tmpdir(), '.navvi-ffmpeg.pid');
const STATEFILE = path.join(os.tmpdir(), '.navvi-mode');
const RECORDINGS_DIR = path.join(os.tmpdir(), 'navvi-recordings');
const SNAPSHOT_DIR = path.join(os.tmpdir(), 'navvi-snapshots');

let pinchtabApi = process.env.PINCHTAB_API || `http://127.0.0.1:${PINCHTAB_PORT}`;
let pinchtabToken = process.env.PINCHTAB_TOKEN || '';

// Auto-read token from PinchTab config if not set
if (!pinchtabToken) {
  const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'pinchtab', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (cfg.server && cfg.server.token) pinchtabToken = cfg.server.token;
  } catch {}
}

// --- Helpers ---

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 60000 }).trim();
  } catch (e) {
    return e.stderr ? e.stderr.trim() : e.message;
  }
}

function which(bin) {
  try {
    return execSync(`which ${bin} 2>/dev/null`, { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function killPidfile(pidfile) {
  if (!fs.existsSync(pidfile)) return;
  try {
    const pid = parseInt(fs.readFileSync(pidfile, 'utf8').trim());
    process.kill(pid);
  } catch {}
  try { fs.unlinkSync(pidfile); } catch {}
}

function getMode() {
  try { return fs.readFileSync(STATEFILE, 'utf8').trim(); } catch { return null; }
}

function setMode(mode) {
  fs.writeFileSync(STATEFILE, mode);
}

function clearMode() {
  try { fs.unlinkSync(STATEFILE); } catch {}
}

function apiCall(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, pinchtabApi);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(pinchtabToken ? { 'Authorization': `Bearer ${pinchtabToken}` } : {}),
      },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function isPinchtabReachable() {
  try {
    const tokenHeader = pinchtabToken ? `-H "Authorization: Bearer ${pinchtabToken}"` : '';
    const result = sh(`curl -sf -o /dev/null -w '%{http_code}' ${tokenHeader} ${pinchtabApi}/instances 2>/dev/null`);
    return result === '200';
  } catch {
    return false;
  }
}

async function getFirstInstance() {
  const instances = await apiCall('GET', '/instances');
  if (!Array.isArray(instances) || instances.length === 0) return null;
  return instances[0].id;
}

async function getFirstTab(instanceId) {
  const tabs = await apiCall('GET', `/instances/${instanceId}/tabs`);
  if (!Array.isArray(tabs) || tabs.length === 0) return null;
  return tabs[0].id;
}

// Snap + save JSONL so agents have fresh refs.
// Returns { path, count, title, url } from the saved snapshot.
async function autoInspect(tabId) {
  const snapshot = await apiCall('GET', `/tabs/${tabId}/snapshot`);
  return saveSnapshotToFile(snapshot);
}



// Save snapshot to a timestamped JSONL file and symlink latest.jsonl to it.
// Agents grep /tmp/navvi-snapshots/latest.jsonl for refs; timestamped files
// stay around for debugging and replaying interaction sequences.
function saveSnapshotToFile(snapshot) {
  if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

  const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
  const nodes = data.nodes || [];
  const title = data.title || '';
  const url = data.url || '';
  const ts = Date.now();

  // Write timestamped file
  const tsFile = path.join(SNAPSHOT_DIR, `inspect-${ts}.jsonl`);
  const lines = [`{"_meta":{"title":${JSON.stringify(title)},"url":${JSON.stringify(url)},"count":${nodes.length},"ts":${ts}}}`];
  for (const n of nodes) {
    lines.push(JSON.stringify(n));
  }
  fs.writeFileSync(tsFile, lines.join('\n') + '\n');

  // Symlink latest → timestamped file
  const latestPath = path.join(SNAPSHOT_DIR, 'latest.jsonl');
  try { fs.unlinkSync(latestPath); } catch {}
  fs.symlinkSync(tsFile, latestPath);

  return { path: latestPath, count: nodes.length, title, url };
}

// --- Dependency checks ---

function checkLocalDeps() {
  const missing = [];

  // Check PinchTab
  const pt = which('pinchtab');
  if (!pt) {
    missing.push({
      name: 'PinchTab',
      install: [
        'curl -fsSL https://pinchtab.com/install.sh | bash',
        'curl -fsSL https://github.com/pinchtab/pinchtab/releases/latest/download/pinchtab-darwin-$(uname -m | sed s/x86_64/amd64/) -o /usr/local/bin/pinchtab && chmod +x /usr/local/bin/pinchtab',
      ],
    });
  }

  // Check Chrome or Chromium
  const chromePaths = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ];
  const hasChrome = chromePaths.some((p) => fs.existsSync(p)) || which('chromium') || which('google-chrome');
  if (!hasChrome) {
    missing.push({
      name: 'Chrome or Chromium',
      install: [
        'brew install --cask google-chrome',
        'brew install --cask chromium',
      ],
    });
  }

  return missing;
}

function checkRemoteDeps() {
  const missing = [];
  if (!which('gh')) {
    missing.push({
      name: 'GitHub CLI (gh)',
      install: ['brew install gh'],
    });
  }
  return missing;
}

function formatMissing(missing) {
  let msg = 'Missing dependencies:\n\n';
  for (const dep of missing) {
    msg += `${dep.name} — install with any of:\n`;
    for (const cmd of dep.install) {
      msg += `  $ ${cmd}\n`;
    }
    msg += '\n';
  }
  msg += 'Install the missing dependencies and try again.';
  return msg;
}

// --- MCP Tool Definitions ---

const TOOLS = [
  {
    name: 'navvi_start',
    description: 'Start Navvi in local or remote mode. Local runs PinchTab directly on your machine. Remote spins up a GitHub Codespace and port-forwards PinchTab.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['local', 'remote'], description: 'Run locally or in a Codespace' },
        name: { type: 'string', description: 'Codespace name to resume (remote mode only, optional)' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'navvi_stop',
    description: 'Stop Navvi — kills local PinchTab or stops Codespace + port forward.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Codespace name (remote mode, optional — stops first running if omitted)' },
      },
    },
  },
  {
    name: 'navvi_status',
    description: 'Show current Navvi state — mode (local/remote/off), PinchTab reachability, running browser instances.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_list',
    description: 'List available Codespaces for Navvi (remote mode).',
    inputSchema: { type: 'object', properties: {} },
  },
  // Browser control (PinchTab)
  {
    name: 'navvi_up',
    description: 'Launch a browser instance for a persona. Requires navvi_start first.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona name (e.g. "fry-dev")' },
        mode: { type: 'string', enum: ['headed', 'headless'], default: 'headed' },
      },
      required: ['persona'],
    },
  },
  {
    name: 'navvi_down',
    description: 'Stop a browser instance. Stops all if no persona specified.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona name (optional — stops all if omitted)' },
      },
    },
  },
  {
    name: 'navvi_open',
    description: 'Open a URL in the active browser instance. Auto-inspects the page after load and returns the JSONL path with element refs. Grep the JSONL for roles like "combobox", "textbox", or "button" to find interactive elements before calling navvi_click or navvi_fill.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        inspect: { type: 'boolean', default: true, description: 'Auto-inspect after load (default: true). Set false to skip.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'navvi_inspect',
    description: 'Get the accessibility tree of the current page (cheap — no image, just element refs). Saves a JSONL file to /tmp/navvi-snapshots/latest.jsonl. Grep it for roles like "combobox", "textbox", "button" to find interactive elements. Each node has a "ref" (e.g. "e42") you pass to navvi_click or navvi_fill. Prefer this over navvi_screenshot when you only need refs — it is much cheaper. You MUST call this before every navvi_click or navvi_fill — refs shift when the DOM changes, so always get fresh refs right before acting.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_click',
    description: 'Click an element by its accessibility tree ref OR by x,y coordinates. Use ref for normal DOM elements. Use x,y for elements not in the accessibility tree (CAPTCHAs, canvas, iframes). When using coordinates, take a navvi_screenshot first to identify the target position. IMPORTANT: refs shift when the DOM changes — always call navvi_inspect immediately before clicking by ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the LATEST navvi_inspect JSONL (e.g. "e42"). Omit when using x,y coordinates.' },
        x: { type: 'number', description: 'X coordinate to click (pixels from left). Use with y instead of ref for coordinate-based clicking.' },
        y: { type: 'number', description: 'Y coordinate to click (pixels from top). Use with x instead of ref for coordinate-based clicking.' },
      },
    },
  },
  {
    name: 'navvi_fill',
    description: 'Type text into an input field using keystroke events (fires JS input/change listeners). Verifies after typing that the value was actually entered. If verification fails, you will get a WARNING — retry with navvi_click first, then navvi_fill again. Call navvi_inspect before this to get fresh refs.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from the LATEST navvi_inspect JSONL (e.g. "e15"). Grep /tmp/navvi-snapshots/latest.jsonl for role/name to find it.' },
        value: { type: 'string', description: 'Text to type into the input' },
        delay: { type: 'number', description: 'Delay in ms between each character (default: 25). Use 80-150 for natural typing speed during recordings.' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'navvi_press',
    description: 'Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, etc.). Use after navvi_fill to submit a form (e.g. press Enter to search). No ref needed — sends the key to the currently focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name to press (e.g. "Enter", "Tab", "Escape", "Backspace", "ArrowDown", "ArrowUp").' },
      },
      required: ['key'],
    },
  },
  {
    name: 'navvi_screenshot',
    description: 'Take a screenshot of the current page. Saves image to /tmp and returns the file path. EXPENSIVE — use navvi_inspect instead when you only need element refs. Only use this when you need to visually verify what the page looks like. Optionally also runs navvi_inspect (default: true).',
    inputSchema: {
      type: 'object',
      properties: {
        describe: { type: 'boolean', default: true, description: 'Also run navvi_inspect and include page summary (default: true). Set false for image only.' },
      },
    },
  },
  // Video recording
  {
    name: 'navvi_record_start',
    description: 'Start recording the browser tab via PinchTab CDP screenshots. Captures frames in background, assembles to MP4 on stop. Works on any platform (local + remote).',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'number', description: 'Max duration in seconds (default: 30, max: 120). Recording auto-stops after this.' },
      },
    },
  },
  {
    name: 'navvi_record_stop',
    description: 'Stop an active recording. Returns the file path, size, and duration. Do NOT use Read on the video file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_record_gif',
    description: 'Convert a recorded video to an optimized GIF (1600px wide, 8fps, palette-optimized). Returns the GIF file path and size.',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Path to input video file. If omitted, uses the most recent recording.' },
      },
    },
  },
];

// --- Tool Handlers ---

async function handleTool(name, args) {
  switch (name) {
    // --- Lifecycle ---

    case 'navvi_start': {
      const currentMode = getMode();
      if (currentMode) {
        return `Navvi is already running in ${currentMode} mode.\nUse navvi_stop first, or navvi_status to check.`;
      }

      if (args.mode === 'local') {
        // Check dependencies
        const missing = checkLocalDeps();
        if (missing.length > 0) return formatMissing(missing);

        // Check if PinchTab is already running
        if (isPinchtabReachable()) {
          setMode('local');
          return 'Navvi started (local). PinchTab was already running on port ' + PINCHTAB_PORT + '.';
        }

        // Start PinchTab locally
        const child = spawn('pinchtab', ['server'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        fs.writeFileSync(PIDFILE_LOCAL, String(child.pid));

        // Wait for PinchTab to launch Chrome and be ready
        await new Promise((r) => setTimeout(r, 4000));
        const reachable = isPinchtabReachable();
        if (reachable) {
          setMode('local');
          return `Navvi started (local). PinchTab running on port ${PINCHTAB_PORT} (PID ${child.pid}).\nLaunch a browser with navvi_up.`;
        } else {
          return `PinchTab started (PID ${child.pid}) but not yet reachable.\nIt may need a moment — try navvi_status in a few seconds.`;
        }
      }

      if (args.mode === 'remote') {
        // Check dependencies
        const missing = checkRemoteDeps();
        if (missing.length > 0) return formatMissing(missing);

        let csName = args.name;
        if (csName) {
          // Resume existing
          sh(`gh cs start -c ${csName}`);
        } else {
          // Try to find an existing stopped one first
          const stopped = sh(`gh cs list --repo ${REPO} --json name,state -q '.[] | select(.state=="Shutdown") | .name'`);
          if (stopped) {
            csName = stopped.split('\n')[0];
            sh(`gh cs start -c ${csName}`);
          } else {
            csName = sh(`gh cs create --repo ${REPO} --machine ${MACHINE_TYPE} --json name -q '.name'`);
          }
        }

        if (!csName) return 'Failed to start Codespace. Check gh auth status.';

        // Port forward
        killPidfile(PIDFILE_FWD);
        const child = spawn('gh', ['cs', 'ports', 'forward', `${PINCHTAB_PORT}:${PINCHTAB_PORT}`, '-c', csName], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
        fs.writeFileSync(PIDFILE_FWD, String(child.pid));

        await new Promise((r) => setTimeout(r, 3000));
        const reachable = isPinchtabReachable();
        setMode('remote:' + csName);
        return `Navvi started (remote). Codespace: ${csName}\n  Port forward: localhost:${PINCHTAB_PORT} → Codespace\n  PinchTab: ${reachable ? 'reachable' : 'not yet reachable (may need to start PinchTab inside the Codespace)'}\nLaunch a browser with navvi_up.`;
      }

      return 'Invalid mode. Use "local" or "remote".';
    }

    case 'navvi_stop': {
      const currentMode = getMode();
      if (!currentMode) return 'Navvi is not running.';

      if (currentMode === 'local') {
        killPidfile(PIDFILE_LOCAL);
        clearMode();
        return 'Navvi stopped (local). PinchTab killed.';
      }

      if (currentMode.startsWith('remote:')) {
        const csName = args.name || currentMode.split(':')[1];
        killPidfile(PIDFILE_FWD);
        if (csName) sh(`gh cs stop -c ${csName}`);
        clearMode();
        return `Navvi stopped (remote). Codespace ${csName} stopped, port forward killed.`;
      }

      clearMode();
      return 'Navvi stopped.';
    }

    case 'navvi_status': {
      const currentMode = getMode();
      const reachable = isPinchtabReachable();
      let status = `Mode: ${currentMode || 'off'}\nPinchTab: ${reachable ? 'reachable' : 'not reachable'}`;

      if (fs.existsSync(PIDFILE_LOCAL)) {
        status += `\nLocal PinchTab PID: ${fs.readFileSync(PIDFILE_LOCAL, 'utf8').trim()}`;
      }
      if (fs.existsSync(PIDFILE_FWD)) {
        status += `\nPort forward PID: ${fs.readFileSync(PIDFILE_FWD, 'utf8').trim()}`;
      }

      if (reachable) {
        try {
          const instances = await apiCall('GET', '/instances');
          if (Array.isArray(instances) && instances.length > 0) {
            status += '\n\nBrowser instances:\n' +
              instances.map((i) => `  ${i.name || 'unnamed'} — ${i.id} (${i.mode || 'unknown'})`).join('\n');
          } else {
            status += '\n\nNo browser instances running. Launch one with navvi_up.';
          }
        } catch {
          status += '\n\nCould not list instances.';
        }
      }
      return status;
    }

    case 'navvi_list': {
      const missing = checkRemoteDeps();
      if (missing.length > 0) return formatMissing(missing);

      const output = sh(`gh cs list --repo ${REPO} --json name,state,createdAt,machine -q '.[] | "\\(.name)  \\(.state)  \\(.machine.displayName // "unknown")  \\(.createdAt)"'`);
      if (!output) return `No Codespaces found for ${REPO}.\nCreate one with navvi_start --mode remote.`;
      return `Navvi Codespaces:\n${output}`;
    }

    // --- Browser control (PinchTab) ---

    case 'navvi_up': {
      if (!isPinchtabReachable()) return 'PinchTab not reachable. Run navvi_start first.';
      const { persona, mode = 'headed' } = args;
      const result = await apiCall('POST', '/instances/launch', {
        name: persona,
        mode,
        profile: `.navvi/profiles/${persona}`,
      });
      return `Instance launched: ${result.id || JSON.stringify(result)}`;
    }

    case 'navvi_down': {
      if (!isPinchtabReachable()) return 'PinchTab not reachable.';
      const instances = await apiCall('GET', '/instances');
      if (!Array.isArray(instances) || instances.length === 0) return 'No running instances.';
      const toStop = args.persona
        ? instances.filter((i) => i.name === args.persona)
        : instances;
      for (const inst of toStop) {
        await apiCall('DELETE', `/instances/${inst.id}`);
      }
      return `Stopped ${toStop.length} instance(s).`;
    }

    case 'navvi_open': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance. Use navvi_up first.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      const result = await apiCall('POST', `/tabs/${tabId}/navigate`, { url: args.url });

      let msg = `Opened ${args.url}` + (result.tabId ? ` (tab: ${result.tabId})` : '');

      // Auto-inspect after page load (unless opted out)
      if (args.inspect !== false) {
        // Wait for DOM to settle — navigation may still be loading
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const info = await autoInspect(tabId);
          msg += `\n\n${info.count} nodes — ${info.path}\nPage: ${info.title || info.url || '(untitled)'}\n\nGrep the JSONL for element refs before calling navvi_click or navvi_fill.`;
        } catch {
          msg += '\n\n(Auto-inspect failed — call navvi_inspect manually.)';
        }
      }

      return msg;
    }

    case 'navvi_inspect': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      const snapshot = await apiCall('GET', `/tabs/${tabId}/snapshot`);
      const info = saveSnapshotToFile(snapshot);
      return `${info.count} nodes — ${info.path}\nPage: ${info.title || info.url || '(untitled)'}\n\nGrep this file for element refs — e.g. grep "combobox" or "button" to find interactive elements.`;
    }

    case 'navvi_click': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      if (args.x !== undefined && args.y !== undefined) {
        // Coordinate-based click (for CAPTCHAs, canvas, elements not in a11y tree)
        await apiCall('POST', `/tabs/${tabId}/action`, { type: 'mouse', kind: 'click', x: args.x, y: args.y });
        return `Clicked at (${args.x}, ${args.y})`;
      }
      if (!args.ref) return 'Error: provide either ref or x,y coordinates.';
      await apiCall('POST', `/tabs/${tabId}/action`, { type: 'mouse', kind: 'click', ref: args.ref });
      return `Clicked ${args.ref}`;
    }

    case 'navvi_fill': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      const charDelay = args.delay !== undefined ? args.delay : 25;

      // Click to focus, then type char-by-char
      await apiCall('POST', `/tabs/${tabId}/action`, { type: 'mouse', kind: 'click', ref: args.ref });
      for (let i = 0; i < args.value.length; i++) {
        await apiCall('POST', `/tabs/${tabId}/action`, {
          type: 'keyboard', kind: 'type', ref: args.ref, text: args.value[i],
        });
        if (charDelay > 0) await new Promise((r) => setTimeout(r, charDelay));
      }

      // Verify: re-inspect and check the element's value/name changed
      let msg = `Filled ${args.ref} with "${args.value}"${charDelay ? ` (${charDelay}ms/char)` : ''}`;
      try {
        const snapshot = await apiCall('GET', `/tabs/${tabId}/snapshot`);
        const data = typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
        const nodes = data.nodes || [];
        const target = nodes.find((n) => n.ref === args.ref);
        if (target) {
          const actual = target.value || target.name || '';
          if (actual.includes(args.value)) {
            msg += `\nVerified: value contains "${args.value}"`;
          } else {
            msg += `\nWARNING: element value is "${actual}" — expected "${args.value}". The fill may have failed. Try navvi_click on the element first, then retry.`;
          }
        }
        saveSnapshotToFile(snapshot);
      } catch {}

      return msg;
    }

    case 'navvi_press': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      await apiCall('POST', `/tabs/${tabId}/action`, { type: 'keyboard', kind: 'press', key: args.key });
      return `Pressed ${args.key}`;
    }

    case 'navvi_screenshot': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';

      // Save screenshot to /tmp — use PinchTab's screenshot endpoint with tabId param
      const filepath = await new Promise((resolve, reject) => {
        const url = new URL(`/screenshot?tabId=${tabId}&quality=80&raw=true`, pinchtabApi);
        const opts = { headers: pinchtabToken ? { 'Authorization': `Bearer ${pinchtabToken}` } : {} };
        http.get(url, opts, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks);
            let imgBuf;
            let ext = 'jpg';
            try {
              const json = JSON.parse(raw.toString('utf8'));
              imgBuf = Buffer.from(json.base64 || json.data || '', 'base64');
            } catch {
              // Fallback: raw binary image
              imgBuf = raw;
              ext = 'png';
            }
            const filename = `navvi-screenshot-${Date.now()}.${ext}`;
            const fp = path.join(os.tmpdir(), filename);
            fs.writeFileSync(fp, imgBuf);
            resolve({ path: fp, sizeKB: Math.round(imgBuf.length / 1024) });
          });
        }).on('error', reject);
      });

      let result = `Screenshot saved to ${filepath.path} (${filepath.sizeKB}KB).`;

      if (args.describe !== false) {
        try {
          const snapshot = await apiCall('GET', `/tabs/${tabId}/snapshot`);
          const info = saveSnapshotToFile(snapshot);
          result += `\nInspect: ${info.count} nodes — ${info.path}`;
          result += `\nPage: ${info.title || info.url || '(untitled)'}`;
        } catch {
          result += '\n(Could not inspect page.)';
        }
      }

      return result;
    }

    // --- Video recording (PinchTab screenshot-based) ---

    case 'navvi_record_start': {
      if (!isPinchtabReachable()) return 'Error: PinchTab not reachable. Use navvi_start first.';

      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running browser instance. Use navvi_up first.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';

      // Check for existing recording
      const stateFile = path.join(os.tmpdir(), '.navvi-recording.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.active) return `Recording already in progress (${state.frames} frames captured). Use navvi_record_stop first.`;
      }

      if (!which('ffmpeg')) return 'Error: ffmpeg not installed. Install with: brew install ffmpeg';
      if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

      const duration = Math.min(args.duration || 30, 120);
      const fps = 4;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const framesDir = path.join(RECORDINGS_DIR, `frames-${ts}`);
      fs.mkdirSync(framesDir, { recursive: true });

      const state = { active: true, framesDir, ts, fps, duration, tabId, frames: 0, startTime: Date.now() };
      fs.writeFileSync(stateFile, JSON.stringify(state));

      // Capture loop: PinchTab screenshots via HTTP API
      const captureScript = `
const http = require('http');
const fs = require('fs');
const framesDir = ${JSON.stringify(framesDir)};
const stateFile = ${JSON.stringify(stateFile)};
const tabId = ${JSON.stringify(tabId)};
const api = ${JSON.stringify(pinchtabApi)};
const token = ${JSON.stringify(pinchtabToken)};
const fps = ${fps};
const maxFrames = ${duration} * fps;
let frame = 0;

function grabFrame() {
  return new Promise((resolve) => {
    const url = new URL('/screenshot?tabId=' + tabId + '&quality=80&raw=true', api);
    const opts = { headers: token ? { 'Authorization': 'Bearer ' + token } : {}, timeout: 500 };
    const req = http.get(url, opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let img;
        try {
          const j = JSON.parse(raw.toString('utf8'));
          img = Buffer.from(j.base64 || j.data || '', 'base64');
        } catch (e) { img = raw; }
        const name = 'frame-' + String(frame).padStart(6, '0') + '.jpg';
        fs.writeFileSync(framesDir + '/' + name, img);
        frame++;
        try {
          const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          s.frames = frame;
          fs.writeFileSync(stateFile, JSON.stringify(s));
        } catch (e2) {}
        resolve();
      });
    }).on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

async function run() {
  console.log('Capture started: ' + maxFrames + ' max frames at ' + fps + 'fps');
  console.log('Tab: ' + tabId + ', API: ' + api);
  const interval = 1000 / fps;
  while (frame < maxFrames) {
    const t0 = Date.now();
    try { await grabFrame(); } catch (e) { console.error('Frame ' + frame + ' error:', e.message); }
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, interval - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!s.active) break;
    } catch (e3) { break; }
  }
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    s.active = false;
    s.frames = frame;
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch (e4) {}
}
run();
`;

      const scriptFile = path.join(os.tmpdir(), '.navvi-capture.cjs');
      fs.writeFileSync(scriptFile, captureScript);

      const nodeBin = which('node') || '/usr/local/bin/node';
      const logFile = path.join(RECORDINGS_DIR, `capture-${ts}.log`);
      const logFd = fs.openSync(logFile, 'w');
      const child = spawn(nodeBin, [scriptFile], {
        detached: true,
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
      fs.writeFileSync(PIDFILE_RECORD, String(child.pid));

      return `Recording started (PinchTab screenshots at ${fps}fps, max ${duration}s).\nFrames dir: ${framesDir}\nUse navvi_record_stop to finish and assemble video.`;
    }

    case 'navvi_record_stop': {
      const stateFile = path.join(os.tmpdir(), '.navvi-recording.json');
      if (!fs.existsSync(stateFile)) return 'No active recording found.';

      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));

      // Signal the capture loop to stop
      state.active = false;
      fs.writeFileSync(stateFile, JSON.stringify(state));

      // Kill capture process
      if (fs.existsSync(PIDFILE_RECORD)) {
        try {
          const pid = parseInt(fs.readFileSync(PIDFILE_RECORD, 'utf8').trim());
          process.kill(pid, 'SIGTERM');
        } catch {}
        try { fs.unlinkSync(PIDFILE_RECORD); } catch {}
      }

      await new Promise((r) => setTimeout(r, 1000)); // let last frame flush

      // Re-read final state
      const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const { framesDir, fps, frames, ts } = finalState;

      if (!frames || frames === 0) {
        try { fs.unlinkSync(stateFile); } catch {}
        return 'Recording stopped but no frames were captured.';
      }

      // Assemble frames into MP4 with ffmpeg
      // Use concat demuxer instead of %06d pattern — tolerates gaps in sequence
      const ffmpegBin = which('ffmpeg') || '/usr/local/bin/ffmpeg';
      const outputFile = path.join(RECORDINGS_DIR, `${ts}.mp4`);
      const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.jpg')).sort();
      const concatFile = path.join(framesDir, 'concat.txt');
      const concatLines = frameFiles.map(f => `file '${path.join(framesDir, f)}'\nduration ${(1/fps).toFixed(4)}`);
      // Add last file again without duration (ffmpeg concat requirement)
      if (frameFiles.length > 0) concatLines.push(`file '${path.join(framesDir, frameFiles[frameFiles.length - 1])}'`);
      fs.writeFileSync(concatFile, concatLines.join('\n') + '\n');
      const assembleResult = sh(`"${ffmpegBin}" -y -f concat -safe 0 -i "${concatFile}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "${outputFile}" 2>&1`);

      // Clean up frames dir
      try {
        const frameFiles = fs.readdirSync(framesDir);
        for (const f of frameFiles) fs.unlinkSync(path.join(framesDir, f));
        fs.rmdirSync(framesDir);
      } catch {}
      try { fs.unlinkSync(stateFile); } catch {}

      if (!fs.existsSync(outputFile)) {
        // Check for capture log
        const logGlob = fs.readdirSync(RECORDINGS_DIR).filter(f => f.startsWith('capture-') && f.endsWith('.log'));
        const logHint = logGlob.length > 0 ? `\nCapture log: ${path.join(RECORDINGS_DIR, logGlob[logGlob.length - 1])}` : '';
        return `Failed to assemble video.\n${assembleResult}${logHint}`;
      }

      const sizeKB = Math.round(fs.statSync(outputFile).size / 1024);
      const durationSec = (frames / fps).toFixed(1);

      return `Recording stopped.\nFile: ${outputFile}\nFrames: ${frames} at ${fps}fps\nDuration: ${durationSec}s\nSize: ${sizeKB}KB\n\nConvert to GIF with navvi_record_gif.`;
    }

    case 'navvi_record_gif': {
      if (!which('ffmpeg')) return 'Error: ffmpeg not installed.';

      let input = args.input;
      if (!input) {
        // Find most recent recording
        if (!fs.existsSync(RECORDINGS_DIR)) return 'No recordings directory found.';
        const files = fs.readdirSync(RECORDINGS_DIR)
          .filter((f) => f.match(/\.(mp4|mov)$/))
          .sort()
          .reverse();
        if (files.length === 0) return 'No recordings found.';
        input = path.join(RECORDINGS_DIR, files[0]);
      }

      if (!fs.existsSync(input)) return `Error: input file not found: ${input}`;

      const output = input.replace(/\.(mp4|mov)$/, '.gif');
      const palette = path.join(os.tmpdir(), '.navvi-palette.png');

      // Two-pass GIF: palette generation + application
      const pass1 = sh(`ffmpeg -y -i "${input}" -vf "fps=8,scale=1600:-1:flags=lanczos,palettegen" "${palette}" 2>&1`);
      if (!fs.existsSync(palette)) return `GIF palette generation failed.\n${pass1}`;

      const pass2 = sh(`ffmpeg -y -i "${input}" -i "${palette}" -lavfi "fps=8,scale=1600:-1:flags=lanczos [x]; [x][1:v] paletteuse" "${output}" 2>&1`);

      try { fs.unlinkSync(palette); } catch {}

      if (!fs.existsSync(output)) return `GIF conversion failed.\n${pass2}`;

      const sizeKB = Math.round(fs.statSync(output).size / 1024);
      return `GIF created: ${output} (${sizeKB}KB)\n\nDo NOT use Read on this file. Send it via Telegram sendDocument or upload to S3.`;
    }

    default:
      return `Unknown tool: ${name}`;
  }
}

// --- MCP stdio protocol ---

let msgBuffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  msgBuffer += chunk;
  const lines = msgBuffer.split('\n');
  msgBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handleMessage(JSON.parse(line));
    } catch {}
  }
});

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'navvi', version: '0.5.0' },
        },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const { name, arguments: callArgs } = params;
      try {
        const result = await handleTool(name, callArgs || {});
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: String(result) }] },
        });
      } catch (e) {
        send({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true },
        });
      }
      break;
    }

    default:
      if (id) {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` } });
      }
  }
}

// Cleanup on exit
process.on('exit', () => {
  killPidfile(PIDFILE_LOCAL);
  killPidfile(PIDFILE_FWD);
});

process.stderr.write('Navvi MCP server started (v0.5.0)\n');
