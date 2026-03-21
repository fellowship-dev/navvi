#!/usr/bin/env node
/**
 * Navvi MCP Server v0.3.0 — local + remote browser automation.
 *
 * Lifecycle:
 *   navvi_start (local|remote), navvi_stop, navvi_status, navvi_list
 *
 * Browser control (PinchTab):
 *   navvi_up, navvi_down, navvi_open, navvi_snapshot,
 *   navvi_click, navvi_fill, navvi_screenshot
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
const STATEFILE = path.join(os.tmpdir(), '.navvi-mode');

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
    description: 'Open a URL in the active browser instance.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'navvi_snapshot',
    description: 'Get the accessibility tree of the current page (~800 tokens).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_click',
    description: 'Click an element by its accessibility tree ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e42")' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'navvi_fill',
    description: 'Type text into an input element by its accessibility tree ref.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from snapshot (e.g. "e15")' },
        value: { type: 'string', description: 'Text to type' },
      },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'navvi_screenshot',
    description: 'Take a screenshot of the current page. Returns base64-encoded PNG.',
    inputSchema: { type: 'object', properties: {} },
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
      return `Opened ${args.url}` + (result.tabId ? ` (tab: ${result.tabId})` : '');
    }

    case 'navvi_snapshot': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      const snapshot = await apiCall('GET', `/tabs/${tabId}/snapshot`);
      return typeof snapshot === 'string' ? snapshot : JSON.stringify(snapshot, null, 2);
    }

    case 'navvi_click': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      await apiCall('POST', `/tabs/${tabId}/action`, { type: 'click', ref: args.ref });
      return `Clicked ${args.ref}`;
    }

    case 'navvi_fill': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      await apiCall('POST', `/tabs/${tabId}/action`, { type: 'fill', ref: args.ref, value: args.value });
      return `Filled ${args.ref} with "${args.value}"`;
    }

    case 'navvi_screenshot': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      return new Promise((resolve, reject) => {
        const url = new URL(`/tabs/${tabId}/screenshot`, pinchtabApi);
        const opts = { headers: pinchtabToken ? { 'Authorization': `Bearer ${pinchtabToken}` } : {} };
        http.get(url, opts, (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const buffer = Buffer.concat(chunks);
            resolve({ type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' });
          });
        }).on('error', reject);
      });
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
          serverInfo: { name: 'navvi', version: '0.3.0' },
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
        if (typeof result === 'object' && result.type === 'image') {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] },
          });
        } else {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: String(result) }] },
          });
        }
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

process.stderr.write('Navvi MCP server started (v0.3.0)\n');
