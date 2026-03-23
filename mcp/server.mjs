#!/usr/bin/env node
/**
 * Navvi MCP Server v2.0.0 — persistent browser personas via Docker containers.
 *
 * Lifecycle:
 *   navvi_start (local|remote), navvi_stop, navvi_status, navvi_list
 *
 * Browser control (xdotool + Marionette via navvi-server.py):
 *   navvi_open, navvi_click, navvi_fill, navvi_press,
 *   navvi_drag, navvi_mousedown, navvi_mouseup, navvi_mousemove,
 *   navvi_scroll, navvi_screenshot, navvi_url, navvi_vnc
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

// --- Constants ---

const REPO = process.env.NAVVI_REPO || 'Fellowship-dev/navvi';
const MACHINE_TYPE = process.env.NAVVI_MACHINE || 'basicLinux32gb';
const NAVVI_PORT = 8024;
const VNC_PORT = 6080;
const DOCKER_IMAGE = process.env.NAVVI_IMAGE || 'navvi';
const CONTAINER_PREFIX = 'navvi-';

const PIDFILE_FWD = path.join(os.tmpdir(), '.navvi-port-forward.pid');
const PIDFILE_RECORD = path.join(os.tmpdir(), '.navvi-ffmpeg.pid');
const STATEFILE = path.join(os.tmpdir(), '.navvi-mode');
const RECORDINGS_DIR = path.join(os.tmpdir(), 'navvi-recordings');
const ACTION_LOG = path.join(os.tmpdir(), '.navvi-actions.jsonl');

let navviApi = `http://127.0.0.1:${NAVVI_PORT}`;

// Track active persona for default targeting
let activePersona = null;

// --- Helpers ---

/** Log an action timestamp during recording (for smart trim) */
function logAction(action, detail) {
  const stateFile = path.join(os.tmpdir(), '.navvi-recording.json');
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!state.active) return;
  } catch { return; }
  const entry = JSON.stringify({ ts: Date.now(), action, detail });
  fs.appendFileSync(ACTION_LOG, entry + '\n');
}

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

/** Run a gh CLI command with CODESPACE_TOKEN as GH_TOKEN */
function ghSh(cmd) {
  const token = process.env.CODESPACE_TOKEN;
  if (!token) return sh(cmd);
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout: 60000,
      env: { ...process.env, GH_TOKEN: token },
    }).trim();
  } catch (e) {
    return e.stderr ? e.stderr.trim() : e.message;
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

/** Get the container name for a persona */
function containerName(persona) {
  return `${CONTAINER_PREFIX}${persona}`;
}

/** Get assigned ports for a persona based on container inspect */
function getContainerPorts(persona) {
  try {
    const name = containerName(persona);
    const info = sh(`docker inspect --format '{{json .NetworkSettings.Ports}}' ${name} 2>/dev/null`);
    const ports = JSON.parse(info);
    const apiPort = ports['8024/tcp']?.[0]?.HostPort || NAVVI_PORT;
    const vncPort = ports['6080/tcp']?.[0]?.HostPort || VNC_PORT;
    return { api: parseInt(apiPort), vnc: parseInt(vncPort) };
  } catch {
    return { api: NAVVI_PORT, vnc: VNC_PORT };
  }
}

/** Read persona YAML file (simple line parser, no deps) */
function readPersonaYaml(persona) {
  const dirs = [
    path.join(process.cwd(), 'personas'),
    path.join(process.cwd(), '.navvi', 'personas'),
  ];
  for (const dir of dirs) {
    for (const ext of ['.yaml', '.yml']) {
      const filepath = path.join(dir, persona + ext);
      try {
        const text = fs.readFileSync(filepath, 'utf8');
        const result = {};
        for (const line of text.split('\n')) {
          const match = line.match(/^\s{0,2}(\w+):\s*(.+)/);
          if (match) result[match[1]] = match[2].trim();
        }
        return result;
      } catch {}
    }
  }
  return {};
}

/** HTTP call to navvi-server.py API */
function apiCall(method, apiPath, body, apiBase) {
  return new Promise((resolve, reject) => {
    const base = apiBase || navviApi;
    const url = new URL(apiPath, base);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (res.statusCode >= 400) {
          const errMsg = (parsed && parsed.detail) || (parsed && parsed.error) || data || `HTTP ${res.statusCode}`;
          return reject(new Error(`API ${method} ${apiPath} failed (${res.statusCode}): ${errMsg}`));
        }
        resolve(parsed);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    if (body) {
      const payload = JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(payload));
      req.write(payload);
    }
    req.end();
  });
}

/** Check if navvi-server is reachable */
function isApiReachable(port) {
  try {
    const result = sh(`curl -sf -o /dev/null -w '%{http_code}' http://127.0.0.1:${port || NAVVI_PORT}/health 2>/dev/null`);
    return result === '200';
  } catch {
    return false;
  }
}

/** List running navvi containers */
function listContainers() {
  try {
    const output = sh(`docker ps --filter "name=${CONTAINER_PREFIX}" --format '{{json .}}' 2>/dev/null`);
    if (!output) return [];
    return output.split('\n').filter(Boolean).map(line => {
      const c = JSON.parse(line);
      return {
        name: c.Names.replace(CONTAINER_PREFIX, ''),
        id: c.ID,
        state: c.State,
        ports: c.Ports,
        image: c.Image,
      };
    });
  } catch {
    return [];
  }
}

// --- Dependency checks ---

function checkLocalDeps() {
  const missing = [];
  if (!which('docker')) {
    missing.push({
      name: 'Docker',
      install: ['brew install --cask docker'],
    });
  }
  return missing;
}

function checkRemoteDeps() {
  const missing = [];
  if (!which('gh')) {
    missing.push({ name: 'GitHub CLI (gh)', install: ['brew install gh'] });
  }
  return missing;
}

function formatMissing(missing) {
  let msg = 'Missing dependencies:\n\n';
  for (const dep of missing) {
    msg += `${dep.name} — install with:\n`;
    for (const cmd of dep.install) msg += `  $ ${cmd}\n`;
    msg += '\n';
  }
  msg += 'Install the missing dependencies and try again.';
  return msg;
}

// --- MCP Tool Definitions ---

const TOOLS = [
  {
    name: 'navvi_start',
    description: 'Start a Navvi browser container (Firefox + Xvfb + xdotool). Local=Docker, Remote=Codespace. Workflow: navvi_open(url) → navvi_find(selector) → navvi_click/navvi_fill → navvi_screenshot to verify. All input is OS-level (isTrusted:true). If you hit a CAPTCHA you cannot solve (Arkose/FunCaptcha, image puzzles, reCAPTCHA), call navvi_vnc and send the user the noVNC URL so they can solve it manually.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona name (default: "default"). Maps to personas/<name>.yaml and a persistent Docker volume.' },
        mode: { type: 'string', enum: ['local', 'remote'], description: 'Run locally via Docker or in a Codespace (default: local)' },
        name: { type: 'string', description: 'Codespace name to resume (remote mode only, optional)' },
      },
    },
  },
  {
    name: 'navvi_stop',
    description: 'Stop a Navvi container. Stops all if no persona specified. Firefox profile is preserved in the Docker volume.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Persona name (optional — stops all if omitted)' },
      },
    },
  },
  {
    name: 'navvi_status',
    description: 'Show current Navvi state — running containers, API health, active persona.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_list',
    description: 'List available Codespaces for Navvi (remote mode).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_open',
    description: 'Navigate to a URL in the active browser. After navigating, use navvi_find to locate elements on the page, then navvi_click/navvi_fill to interact.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        persona: { type: 'string', description: 'Target persona (optional — uses active if omitted)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'navvi_click',
    description: 'Click at (x, y) screen coordinates using OS-level xdotool input (isTrusted: true). IMPORTANT: Use navvi_find to get coordinates — it returns screen-ready (x, y) values. Do NOT use raw JS getBoundingClientRect() — those are viewport coords that miss the browser chrome offset.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (pixels from left)' },
        y: { type: 'number', description: 'Y coordinate (pixels from top)' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'navvi_fill',
    description: 'Click at (x, y) to focus an input field, then type text using OS-level xdotool. Get coordinates from navvi_find first. Selects existing text (Ctrl+A) before typing to replace any current value.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate of the input field' },
        y: { type: 'number', description: 'Y coordinate of the input field' },
        value: { type: 'string', description: 'Text to type' },
        delay: { type: 'number', description: 'Delay in ms between characters (default: 12). Use 50-100 for natural typing speed.' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x', 'y', 'value'],
    },
  },
  {
    name: 'navvi_press',
    description: 'Press a keyboard key (Enter, Tab, Escape, Backspace, ArrowDown, etc.). Sends to currently focused element.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name (e.g. "Enter", "Tab", "Escape", "Backspace", "ArrowDown")' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['key'],
    },
  },
  {
    name: 'navvi_drag',
    description: 'Drag from (x1,y1) to (x2,y2) with interpolated mouse moves. Uses OS-level input — works on CAPTCHAs and canvases. Get coordinates from navvi_find.',
    inputSchema: {
      type: 'object',
      properties: {
        x1: { type: 'number', description: 'Start X' },
        y1: { type: 'number', description: 'Start Y' },
        x2: { type: 'number', description: 'End X' },
        y2: { type: 'number', description: 'End Y' },
        steps: { type: 'number', description: 'Interpolation steps (default: 20)' },
        duration: { type: 'number', description: 'Drag duration in seconds (default: 0.3)' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
  },
  {
    name: 'navvi_mousedown',
    description: 'Press and hold mouse button at (x, y). Pair with navvi_mouseup for press-and-hold CAPTCHAs. Get coordinates from navvi_find. WARNING: Arkose Labs/FunCaptcha (Microsoft, Yahoo) cannot be solved inside the container even by a human — the virtual display is fingerprinted. If you detect arkoselabs/funcaptcha in the page, stop and tell the user to use a real browser for that signup.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'navvi_mouseup',
    description: 'Release mouse button at (x, y). Pair with navvi_mousedown.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'navvi_mousemove',
    description: 'Move mouse to (x, y) without clicking. Useful for hover effects.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'navvi_scroll',
    description: 'Scroll the page in a given direction.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction (default: down)' },
        amount: { type: 'number', description: 'Number of scroll clicks (default: 3)' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
    },
  },
  {
    name: 'navvi_screenshot',
    description: 'Take a screenshot of the virtual display. Returns file path to a PNG image — use Read tool to view it. Use for VISUAL VERIFICATION only (confirming what happened). To get clickable coordinates, use navvi_find instead — screenshot pixel positions include browser chrome and are not reliable for targeting elements.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
    },
  },
  {
    name: 'navvi_url',
    description: 'Get the current page URL.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
    },
  },
  {
    name: 'navvi_vnc',
    description: 'Get the noVNC URL for live browser view. Share with the user when human intervention is needed: visual CAPTCHAs that require image recognition, OAuth consent screens, or 2FA code entry. The user opens this URL in their real browser to interact directly.',
    inputSchema: {
      type: 'object',
      properties: {
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
    },
  },
  {
    name: 'navvi_find',
    description: 'Find element(s) by CSS selector and return screen-ready (x, y) coordinates. THIS IS THE PRIMARY WAY TO GET COORDINATES — use before navvi_click, navvi_fill, navvi_drag, navvi_mousedown. Automatically corrects for browser chrome offset. Workflow: navvi_find → get (x, y) → navvi_click/navvi_fill at those coords → navvi_screenshot to verify. For dropdowns: navvi_find the button → navvi_click to open → navvi_find the options (selector="[role=option]", all=true) → navvi_click the desired option.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector (e.g. "#email", "input[type=password]", "button[type=submit]")' },
        all: { type: 'boolean', description: 'Return all matches (default: false, returns first match only)' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['selector'],
    },
  },
  // Credentials
  {
    name: 'navvi_creds',
    description: 'Manage credentials stored in gopass inside the container. Three actions: "list" shows available entries (no secrets), "get" retrieves a non-secret field (username, url, email — refuses password), "autofill" reads gopass and fills the login form directly — the password goes from gopass → xdotool → browser, NEVER appearing in this response. Use autofill after navvi_open navigates to a login page.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'get', 'autofill'], description: 'Action: list entries, get a metadata field, or autofill a login form' },
        entry: { type: 'string', description: 'Gopass entry path (e.g. "navvi/default/tuta"). Required for get and autofill.' },
        field: { type: 'string', description: 'Field to retrieve (for "get" action). e.g. "username", "url", "email". Password fields are blocked — use autofill.' },
        username_selector: { type: 'string', description: 'CSS selector for username field (autofill only, default: auto-detect)' },
        password_selector: { type: 'string', description: 'CSS selector for password field (autofill only, default: input[type=password])' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
      required: ['action'],
    },
  },
  // Video recording
  {
    name: 'navvi_record_start',
    description: 'Start recording the browser via screenshot polling. Captures frames in background, assembles to MP4 on stop.',
    inputSchema: {
      type: 'object',
      properties: {
        duration: { type: 'number', description: 'Max duration in seconds (default: 30, max: 120)' },
        persona: { type: 'string', description: 'Target persona (optional)' },
      },
    },
  },
  {
    name: 'navvi_record_stop',
    description: 'Stop recording and assemble frames into MP4. Optionally trims dead time between actions.',
    inputSchema: {
      type: 'object',
      properties: {
        trim: { type: 'boolean', description: 'Trim dead time between actions (default: true)' },
      },
    },
  },
  {
    name: 'navvi_record_gif',
    description: 'Convert a recorded video to an optimized GIF (1600px wide, 8fps, palette-optimized).',
    inputSchema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Path to input video. If omitted, uses most recent recording.' },
      },
    },
  },
];

// --- Tool Handlers ---

/** Resolve which persona to target and return its API base URL */
function resolvePersona(persona) {
  const name = persona || activePersona || 'default';
  const ports = getContainerPorts(name);
  return { name, apiBase: `http://127.0.0.1:${ports.api}` };
}

async function handleTool(name, args) {
  switch (name) {
    // --- Lifecycle ---

    case 'navvi_start': {
      const mode = args.mode || 'local';
      const persona = args.persona || 'default';

      if (mode === 'local') {
        const missing = checkLocalDeps();
        if (missing.length > 0) return formatMissing(missing);

        const cname = containerName(persona);

        // Check if already running
        const existing = sh(`docker ps -q --filter "name=${cname}" 2>/dev/null`);
        if (existing) {
          const ports = getContainerPorts(persona);
          const reachable = isApiReachable(ports.api);
          activePersona = persona;
          navviApi = `http://127.0.0.1:${ports.api}`;
          return `Container ${cname} already running.\nAPI: http://127.0.0.1:${ports.api} (${reachable ? 'healthy' : 'starting...'})\nVNC: http://127.0.0.1:${ports.vnc}`;
        }

        // Remove stopped container with same name
        sh(`docker rm ${cname} 2>/dev/null`);

        // Read persona config for locale/timezone
        const config = readPersonaYaml(persona);
        const locale = config.locale || 'en-US';
        const timezone = config.timezone || 'UTC';

        // Docker volume for persistent Firefox profile
        const volumeName = `navvi-profile-${persona}`;

        // Find free ports if default persona ports are taken
        let apiPort = NAVVI_PORT;
        let vncPort = VNC_PORT;
        // For non-default personas, offset ports
        if (persona !== 'default') {
          // Simple hash to get port offset
          let hash = 0;
          for (const ch of persona) hash = ((hash << 5) - hash + ch.charCodeAt(0)) | 0;
          const offset = (Math.abs(hash) % 100) + 1;
          apiPort = NAVVI_PORT + offset;
          vncPort = VNC_PORT + offset;
        }

        const dockerArgs = [
          'run', '-d',
          '--name', cname,
          '-p', `${apiPort}:8024`,
          '-p', `${vncPort}:6080`,
          '-v', `${volumeName}:/home/user/.mozilla`,
          '-e', `LOCALE=${locale}`,
          '-e', `TIMEZONE=${timezone}`,
          DOCKER_IMAGE,
        ];

        const result = sh(`docker ${dockerArgs.join(' ')}`);
        if (result.includes('Error') || result.includes('error')) {
          return `Failed to start container:\n${result}\n\nMake sure the image is built: docker build -t navvi container/`;
        }

        // Wait for API to be ready
        activePersona = persona;
        navviApi = `http://127.0.0.1:${apiPort}`;

        let ready = false;
        for (let i = 0; i < 15; i++) {
          await new Promise(r => setTimeout(r, 1000));
          if (isApiReachable(apiPort)) { ready = true; break; }
        }

        setMode('local');
        return `Navvi started (${persona}).\nContainer: ${cname}\nAPI: http://127.0.0.1:${apiPort} (${ready ? 'healthy' : 'starting...'})\nVNC: http://127.0.0.1:${vncPort}\nVolume: ${volumeName} (persistent Firefox profile)\n\nUse navvi_open to navigate, navvi_screenshot to see the page.`;
      }

      if (mode === 'remote') {
        const missing = checkRemoteDeps();
        if (missing.length > 0) return formatMissing(missing);

        const csToken = process.env.CODESPACE_TOKEN;
        const ghEnv = csToken ? { ...process.env, GH_TOKEN: csToken } : process.env;

        let csName = args.name;
        if (csName) {
          // SSH auto-starts stopped codespaces (gh cs start doesn't exist)
          try {
            execSync(`gh cs ssh -c ${csName} -- echo ready`, { encoding: 'utf8', timeout: 120000, env: ghEnv });
          } catch {}
        } else {
          const stopped = ghSh(`gh cs list --repo ${REPO} --json name,state -q '.[] | select(.state=="Shutdown") | .name'`);
          if (stopped) {
            csName = stopped.split('\n')[0];
            try {
              execSync(`gh cs ssh -c ${csName} -- echo ready`, { encoding: 'utf8', timeout: 120000, env: ghEnv });
            } catch {}
          } else {
            csName = ghSh(`gh cs create --repo ${REPO} --machine ${MACHINE_TYPE} --json name -q '.name'`);
          }
        }

        if (!csName) return 'Failed to start Codespace. Check gh auth status and CODESPACE_TOKEN env var.';

        // Wait for navvi-server to be ready inside the codespace
        let apiReady = false;
        for (let i = 0; i < 15; i++) {
          try {
            const check = execSync(
              `gh cs ssh -c ${csName} -- python3 -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8024/health').read().decode())"`,
              { encoding: 'utf8', timeout: 10000, env: ghEnv }
            ).trim();
            if (check.includes('"ok":true')) { apiReady = true; break; }
          } catch {}
          await new Promise(r => setTimeout(r, 3000));
        }

        // Port forward both API and VNC
        killPidfile(PIDFILE_FWD);
        const child = spawn('gh', ['cs', 'ports', 'forward', `${NAVVI_PORT}:${NAVVI_PORT}`, `${VNC_PORT}:${VNC_PORT}`, '-c', csName], {
          detached: true,
          stdio: 'ignore',
          env: ghEnv,
        });
        child.unref();
        fs.writeFileSync(PIDFILE_FWD, String(child.pid));

        await new Promise(r => setTimeout(r, 3000));
        const reachable = isApiReachable(NAVVI_PORT);
        setMode('remote:' + csName);
        activePersona = persona;
        return `Navvi started (remote). Codespace: ${csName}\nAPI: localhost:${NAVVI_PORT} (${reachable ? 'healthy' : apiReady ? 'forwarding...' : 'starting...'})\nVNC: localhost:${VNC_PORT}`;
      }

      return 'Invalid mode. Use "local" or "remote".';
    }

    case 'navvi_stop': {
      const persona = args.persona;

      if (persona) {
        const cname = containerName(persona);
        sh(`docker stop ${cname} 2>/dev/null`);
        sh(`docker rm ${cname} 2>/dev/null`);
        if (activePersona === persona) activePersona = null;
        return `Stopped ${cname}. Firefox profile preserved in volume navvi-profile-${persona}.`;
      }

      // Stop all navvi containers
      const containers = listContainers();
      if (containers.length === 0) {
        // Also handle remote mode
        const currentMode = getMode();
        if (currentMode && currentMode.startsWith('remote:')) {
          const csName = currentMode.split(':')[1];
          killPidfile(PIDFILE_FWD);
          if (csName) ghSh(`gh cs stop -c ${csName}`);
          clearMode();
          return `Stopped remote Codespace ${csName}.`;
        }
        clearMode();
        return 'No running Navvi containers.';
      }

      for (const c of containers) {
        sh(`docker stop ${containerName(c.name)} 2>/dev/null`);
        sh(`docker rm ${containerName(c.name)} 2>/dev/null`);
      }
      activePersona = null;
      clearMode();
      return `Stopped ${containers.length} container(s). Firefox profiles preserved in Docker volumes.`;
    }

    case 'navvi_status': {
      const currentMode = getMode();
      const containers = listContainers();
      let status = `Mode: ${currentMode || 'off'}\nActive persona: ${activePersona || 'none'}`;

      if (containers.length > 0) {
        status += '\n\nRunning containers:';
        for (const c of containers) {
          const ports = getContainerPorts(c.name);
          const healthy = isApiReachable(ports.api);
          status += `\n  ${c.name} — API :${ports.api} (${healthy ? 'healthy' : 'unhealthy'}), VNC :${ports.vnc}`;
        }
      } else {
        status += '\n\nNo running containers. Start one with navvi_start.';
      }

      if (fs.existsSync(PIDFILE_FWD)) {
        status += `\nPort forward PID: ${fs.readFileSync(PIDFILE_FWD, 'utf8').trim()}`;
      }

      return status;
    }

    case 'navvi_list': {
      const missing = checkRemoteDeps();
      if (missing.length > 0) return formatMissing(missing);

      const output = ghSh(`gh cs list --repo ${REPO} --json name,state,createdAt,machine -q '.[] | "\\(.name)  \\(.state)  \\(.machine.displayName // "unknown")  \\(.createdAt)"'`);
      if (!output) return `No Codespaces found for ${REPO}.`;
      return `Navvi Codespaces:\n${output}`;
    }

    // --- Browser control ---

    case 'navvi_open': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('open', args.url);
      try {
        const result = await apiCall('POST', '/navigate', { url: args.url }, apiBase);
        return `Opened ${args.url}\nTitle: ${result.title || '(loading...)'}\nURL: ${result.url || args.url}`;
      } catch (e) {
        return `Error navigating: ${e.message}`;
      }
    }

    case 'navvi_click': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('click', `(${args.x}, ${args.y})`);
      try {
        await apiCall('POST', '/click', { x: args.x, y: args.y }, apiBase);
        return `Clicked at (${args.x}, ${args.y})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_fill': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      const delay = args.delay !== undefined ? args.delay : 12;
      const fillDurationMs = args.value.length * delay;
      logAction('fill', { x: args.x, y: args.y, text: args.value, durationMs: fillDurationMs });
      try {
        // Click to focus
        await apiCall('POST', '/click', { x: args.x, y: args.y }, apiBase);
        await new Promise(r => setTimeout(r, 100));
        // Type
        await apiCall('POST', '/type', { text: args.value, delay }, apiBase);
        return `Filled at (${args.x}, ${args.y}) with "${args.value}" (${args.value.length} chars)`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_press': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('press', args.key);
      try {
        await apiCall('POST', '/key', { key: args.key }, apiBase);
        return `Pressed ${args.key}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_drag': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('drag', { from: [args.x1, args.y1], to: [args.x2, args.y2] });
      try {
        const params = {
          x1: args.x1, y1: args.y1,
          x2: args.x2, y2: args.y2,
        };
        if (args.steps) params.steps = args.steps;
        if (args.duration) params.duration = args.duration;
        await apiCall('POST', '/drag', params, apiBase);
        return `Dragged from (${args.x1}, ${args.y1}) to (${args.x2}, ${args.y2})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_mousedown': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('mousedown', `(${args.x}, ${args.y})`);
      try {
        await apiCall('POST', '/mousedown', { x: args.x, y: args.y }, apiBase);
        return `Mouse down at (${args.x}, ${args.y})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_mouseup': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('mouseup', `(${args.x}, ${args.y})`);
      try {
        await apiCall('POST', '/mouseup', { x: args.x, y: args.y }, apiBase);
        return `Mouse up at (${args.x}, ${args.y})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_mousemove': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('mousemove', `(${args.x}, ${args.y})`);
      try {
        await apiCall('POST', '/mousemove', { x: args.x, y: args.y }, apiBase);
        return `Mouse moved to (${args.x}, ${args.y})`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_scroll': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      const direction = args.direction || 'down';
      const amount = args.amount || 3;
      logAction('scroll', `${direction} x${amount}`);
      try {
        await apiCall('POST', '/scroll', { direction, amount }, apiBase);
        return `Scrolled ${direction} x${amount}`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_screenshot': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      try {
        const result = await apiCall('GET', '/screenshot', null, apiBase);
        if (!result.base64) return 'Error: no screenshot data returned.';

        const imgBuf = Buffer.from(result.base64, 'base64');
        const filename = `navvi-screenshot-${Date.now()}.png`;
        const filepath = path.join(os.tmpdir(), filename);
        fs.writeFileSync(filepath, imgBuf);

        const sizeKB = Math.round(imgBuf.length / 1024);
        return `Screenshot saved to ${filepath} (${sizeKB}KB).\nUse Read tool to view the image.`;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_url': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      try {
        const result = await apiCall('GET', '/url', null, apiBase);
        return result.url || '(unknown)';
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    case 'navvi_vnc': {
      const persona = args.persona || activePersona || 'default';
      const ports = getContainerPorts(persona);
      return `noVNC: http://127.0.0.1:${ports.vnc}/vnc.html?autoconnect=true\n\nOpen this URL in a browser for live view. Use for:\n- Human CAPTCHA solving\n- OAuth login flows\n- Visual debugging`;
    }

    case 'navvi_find': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      logAction('find', args.selector);
      try {
        const params = { selector: args.selector };
        if (args.all) params.all = true;
        const result = await apiCall('POST', '/find', params, apiBase);
        if (!result.found) return `No element found for selector: ${args.selector}`;
        if (result.elements) {
          // Multiple results
          let output = `Found ${result.count} element(s) for "${args.selector}":\n`;
          for (const el of result.elements) {
            if (!el.visible) continue;
            output += `  ${el.tag}${el.id ? '#' + el.id : ''} — (${el.x}, ${el.y}) ${el.width}x${el.height}`;
            if (el.text) output += ` "${el.text.slice(0, 40)}"`;
            if (el.placeholder) output += ` placeholder="${el.placeholder}"`;
            output += '\n';
          }
          return output;
        }
        // Single result
        let output = `Found: ${result.tag}${result.id ? '#' + result.id : ''} at (${result.x}, ${result.y}) ${result.width}x${result.height}`;
        if (result.text) output += `\nText: "${result.text}"`;
        if (result.placeholder) output += `\nPlaceholder: "${result.placeholder}"`;
        if (result.value) output += `\nValue: "${result.value}"`;
        output += `\n\nUse navvi_click x=${result.x} y=${result.y} to click this element.`;
        return output;
      } catch (e) {
        return `Error: ${e.message}`;
      }
    }

    // --- Credentials ---

    case 'navvi_creds': {
      const { name: pName, apiBase } = resolvePersona(args.persona);
      const action = args.action;

      if (action === 'list') {
        try {
          const result = await apiCall('GET', '/creds/list', null, apiBase);
          if (!result.entries || result.entries.length === 0) return 'No credentials stored in gopass. Use gopass to add entries.';
          let output = `Credentials (${result.count} entries):\n`;
          for (const e of result.entries) output += `  ${e}\n`;
          return output;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      if (action === 'get') {
        if (!args.entry) return 'Error: "entry" is required for get action.';
        if (!args.field) return 'Error: "field" is required for get action (e.g. "username", "url", "email").';
        try {
          const result = await apiCall('POST', '/creds/get', { entry: args.entry, field: args.field }, apiBase);
          return `${args.field}: ${result.value}`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      if (action === 'autofill') {
        if (!args.entry) return 'Error: "entry" is required for autofill action.';
        logAction('autofill', args.entry);
        try {
          const params = { entry: args.entry };
          if (args.username_selector) params.username_selector = args.username_selector;
          if (args.password_selector) params.password_selector = args.password_selector;
          const result = await apiCall('POST', '/creds/autofill', params, apiBase);
          return `Autofill complete for "${args.entry}".\nUsername filled at (${result.username_at.join(', ')})\nPassword filled at (${result.password_at.join(', ')})\n\n${result.note}`;
        } catch (e) {
          return `Error: ${e.message}`;
        }
      }

      return 'Error: action must be "list", "get", or "autofill".';
    }

    // --- Video recording ---

    case 'navvi_record_start': {
      const { name: pName, apiBase } = resolvePersona(args.persona);

      // Check for existing recording
      const stateFile = path.join(os.tmpdir(), '.navvi-recording.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.active) return `Recording already in progress (${state.frames} frames). Use navvi_record_stop first.`;
      }

      if (!which('ffmpeg')) return 'Error: ffmpeg not installed. Install with: brew install ffmpeg';
      if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

      const duration = Math.min(args.duration || 30, 120);
      const fps = 4;
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const framesDir = path.join(RECORDINGS_DIR, `frames-${ts}`);
      fs.mkdirSync(framesDir, { recursive: true });

      const state = { active: true, framesDir, ts, fps, duration, frames: 0, startTime: Date.now(), apiBase };
      fs.writeFileSync(stateFile, JSON.stringify(state));

      // Clear action log
      try { fs.unlinkSync(ACTION_LOG); } catch {}

      // Capture loop script — hits /screenshot endpoint
      const captureScript = `
const http = require('http');
const fs = require('fs');
const framesDir = ${JSON.stringify(framesDir)};
const stateFile = ${JSON.stringify(stateFile)};
const api = ${JSON.stringify(apiBase)};
const fps = ${fps};
const maxFrames = ${duration} * fps;
let frame = 0;

function grabFrame() {
  return new Promise((resolve) => {
    const url = new URL('/screenshot', api);
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.base64) {
            const img = Buffer.from(j.base64, 'base64');
            const name = 'frame-' + String(frame).padStart(6, '0') + '.png';
            fs.writeFileSync(framesDir + '/' + name, img);
            frame++;
            try {
              const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
              s.frames = frame;
              fs.writeFileSync(stateFile, JSON.stringify(s));
            } catch {}
          }
        } catch {}
        resolve();
      });
    }).on('error', () => resolve());
    req.on('timeout', () => { req.destroy(); resolve(); });
  });
}

async function run() {
  const interval = 1000 / fps;
  while (frame < maxFrames) {
    const t0 = Date.now();
    try { await grabFrame(); } catch {}
    const elapsed = Date.now() - t0;
    const wait = Math.max(0, interval - elapsed);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try {
      const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!s.active) break;
    } catch { break; }
  }
  try {
    const s = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    s.active = false;
    s.frames = frame;
    fs.writeFileSync(stateFile, JSON.stringify(s));
  } catch {}
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

      return `Recording started (${fps}fps, max ${duration}s).\nFrames dir: ${framesDir}\nUse navvi_record_stop to finish.`;
    }

    case 'navvi_record_stop': {
      const stateFile = path.join(os.tmpdir(), '.navvi-recording.json');
      if (!fs.existsSync(stateFile)) return 'No active recording found.';

      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
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

      await new Promise(r => setTimeout(r, 1000));

      const finalState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      const { framesDir, fps, frames, ts } = finalState;

      if (!frames || frames === 0) {
        try { fs.unlinkSync(stateFile); } catch {}
        return 'Recording stopped but no frames were captured.';
      }

      // Assemble frames into MP4
      const ffmpegBin = which('ffmpeg') || '/usr/local/bin/ffmpeg';
      const outputFile = path.join(RECORDINGS_DIR, `${ts}.mp4`);
      const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png')).sort();
      const concatFile = path.join(framesDir, 'concat.txt');
      const concatLines = frameFiles.map(f => `file '${path.join(framesDir, f)}'\nduration ${(1/fps).toFixed(4)}`);
      if (frameFiles.length > 0) concatLines.push(`file '${path.join(framesDir, frameFiles[frameFiles.length - 1])}'`);
      fs.writeFileSync(concatFile, concatLines.join('\n') + '\n');
      const assembleResult = sh(`"${ffmpegBin}" -y -f concat -safe 0 -i "${concatFile}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "${outputFile}" 2>&1`);

      if (!fs.existsSync(outputFile)) {
        try {
          for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));
          fs.rmdirSync(framesDir);
        } catch {}
        try { fs.unlinkSync(stateFile); } catch {}
        return `Failed to assemble video.\n${assembleResult}`;
      }

      const sizeKB = Math.round(fs.statSync(outputFile).size / 1024);
      const durationSec = (frames / fps).toFixed(1);
      let result = `Recording stopped.\nFile: ${outputFile}\nFrames: ${frames} at ${fps}fps\nDuration: ${durationSec}s\nSize: ${sizeKB}KB`;

      // Smart trim
      const shouldTrim = args.trim !== false;
      if (shouldTrim && fs.existsSync(ACTION_LOG)) {
        try {
          const actions = fs.readFileSync(ACTION_LOG, 'utf8').trim().split('\n')
            .map(line => JSON.parse(line));

          if (actions.length > 0 && frameFiles.length > 0) {
            const recordingStart = finalState.startTime;
            const frameDurationMs = 1000 / fps;
            const BEFORE_MS = 1000;
            const AFTER_MS = 3000;
            const keepFrames = new Set();

            for (const action of actions) {
              const actionOffsetMs = action.ts - recordingStart;
              const actionFrame = Math.floor(actionOffsetMs / frameDurationMs);
              const beforeFrames = Math.ceil(BEFORE_MS / frameDurationMs);
              let afterMs = AFTER_MS;
              if (action.action === 'fill' && action.detail && action.detail.durationMs) {
                afterMs = action.detail.durationMs + AFTER_MS;
              }
              const afterFrames = Math.ceil(afterMs / frameDurationMs);
              const start = Math.max(0, actionFrame - beforeFrames);
              const end = Math.min(frameFiles.length - 1, actionFrame + afterFrames);
              for (let i = start; i <= end; i++) keepFrames.add(i);
            }

            if (keepFrames.size < frameFiles.length * 0.8) {
              const trimmedFrames = frameFiles.filter((_, i) => keepFrames.has(i));
              const trimConcatFile = path.join(framesDir, 'concat-trimmed.txt');
              const trimLines = trimmedFrames.map(f => `file '${path.join(framesDir, f)}'\nduration ${(1/fps).toFixed(4)}`);
              if (trimmedFrames.length > 0) trimLines.push(`file '${path.join(framesDir, trimmedFrames[trimmedFrames.length - 1])}'`);
              fs.writeFileSync(trimConcatFile, trimLines.join('\n') + '\n');

              const trimmedFile = path.join(RECORDINGS_DIR, `${ts}-trimmed.mp4`);
              sh(`"${ffmpegBin}" -y -f concat -safe 0 -i "${trimConcatFile}" -vf "scale=trunc(iw/2)*2:trunc(ih/2)*2" -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p "${trimmedFile}" 2>&1`);

              if (fs.existsSync(trimmedFile)) {
                const trimSizeKB = Math.round(fs.statSync(trimmedFile).size / 1024);
                const trimDurationSec = (trimmedFrames.length / fps).toFixed(1);
                result += `\n\nTrimmed: ${trimmedFile}\nDuration: ${trimDurationSec}s (${trimSizeKB}KB)`;
              }
            } else {
              result += '\n\n(Trim skipped — not enough dead time.)';
            }
          }
        } catch (trimErr) {
          result += `\n\n(Trim failed: ${trimErr.message})`;
        }
        try { fs.unlinkSync(ACTION_LOG); } catch {}
      }

      // Clean up frames
      try {
        for (const f of fs.readdirSync(framesDir)) fs.unlinkSync(path.join(framesDir, f));
        fs.rmdirSync(framesDir);
      } catch {}
      try { fs.unlinkSync(stateFile); } catch {}

      result += '\n\nConvert to GIF with navvi_record_gif.';
      return result;
    }

    case 'navvi_record_gif': {
      if (!which('ffmpeg')) return 'Error: ffmpeg not installed.';

      let input = args.input;
      if (!input) {
        if (!fs.existsSync(RECORDINGS_DIR)) return 'No recordings directory found.';
        const files = fs.readdirSync(RECORDINGS_DIR)
          .filter(f => f.match(/\.(mp4|mov)$/))
          .sort()
          .reverse();
        if (files.length === 0) return 'No recordings found.';
        input = path.join(RECORDINGS_DIR, files[0]);
      }

      if (!fs.existsSync(input)) return `Error: input file not found: ${input}`;

      const output = input.replace(/\.(mp4|mov)$/, '.gif');
      const palette = path.join(os.tmpdir(), '.navvi-palette.png');

      const pass1 = sh(`ffmpeg -y -i "${input}" -vf "fps=8,scale=1600:-1:flags=lanczos,palettegen" "${palette}" 2>&1`);
      if (!fs.existsSync(palette)) return `GIF palette generation failed.\n${pass1}`;

      sh(`ffmpeg -y -i "${input}" -i "${palette}" -lavfi "fps=8,scale=1600:-1:flags=lanczos [x]; [x][1:v] paletteuse" "${output}" 2>&1`);

      try { fs.unlinkSync(palette); } catch {}

      if (!fs.existsSync(output)) return 'GIF conversion failed.';

      const sizeKB = Math.round(fs.statSync(output).size / 1024);
      return `GIF created: ${output} (${sizeKB}KB)\n\nDo NOT use Read on this file.`;
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
          serverInfo: { name: 'navvi', version: '2.0.0' },
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
  killPidfile(PIDFILE_FWD);
});

process.stderr.write('Navvi MCP server started (v2.0.0)\n');
