#!/usr/bin/env node
/**
 * Navvi MCP Server — Codespace lifecycle + PinchTab browser control.
 *
 * Codespace tools (work locally, manage remote compute):
 *   navvi_codespaces_list, navvi_codespace_start, navvi_codespace_stop,
 *   navvi_codespace_connect, navvi_codespace_disconnect
 *
 * Browser tools (work once connected to a Codespace):
 *   navvi_up, navvi_down, navvi_status,
 *   navvi_open, navvi_snapshot, navvi_click, navvi_fill, navvi_screenshot
 *
 * Speaks MCP stdio protocol. Zero dependencies (Node built-ins only).
 */

const http = require('http');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO = process.env.NAVVI_REPO || 'Fellowship-dev/navvi';
const MACHINE_TYPE = process.env.NAVVI_MACHINE || 'basicLinux32gb';
const PINCHTAB_PORT = 9867;
const PIDFILE = path.join(os.tmpdir(), '.navvi-port-forward.pid');

let pinchtabApi = process.env.PINCHTAB_API || `http://127.0.0.1:${PINCHTAB_PORT}`;

// --- Shell helper ---

function sh(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 60000 }).trim();
  } catch (e) {
    return e.stderr ? e.stderr.trim() : e.message;
  }
}

// --- HTTP helper (no deps) ---

function apiCall(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, pinchtabApi);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve(data);
        }
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
    const result = sh(`curl -sf -o /dev/null -w '%{http_code}' ${pinchtabApi}/instances 2>/dev/null`);
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

// --- MCP Tool Definitions ---

const TOOLS = [
  // Codespace lifecycle
  {
    name: 'navvi_codespaces_list',
    description: 'List available Navvi Codespaces (running and stopped).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'navvi_codespace_start',
    description: 'Start a new Navvi Codespace or resume a stopped one. Returns codespace name.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Codespace name (optional — creates new if omitted, resumes if provided)' },
      },
    },
  },
  {
    name: 'navvi_codespace_stop',
    description: 'Stop a running Navvi Codespace.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Codespace name (optional — stops first running one if omitted)' },
      },
    },
  },
  {
    name: 'navvi_codespace_connect',
    description: 'Forward PinchTab port from a running Codespace to localhost. Must be called after start and before browser tools.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Codespace name (optional — connects to first running one if omitted)' },
      },
    },
  },
  {
    name: 'navvi_codespace_disconnect',
    description: 'Stop port forwarding to the Codespace.',
    inputSchema: { type: 'object', properties: {} },
  },
  // Browser control (PinchTab)
  {
    name: 'navvi_up',
    description: 'Launch a browser instance for a persona inside the connected Codespace. Returns instance ID.',
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
    name: 'navvi_status',
    description: 'List running browser instances and connection status.',
    inputSchema: { type: 'object', properties: {} },
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
    description: 'Get the accessibility tree of the current page. Returns structured elements with refs for interaction. Much cheaper than screenshots (~800 tokens).',
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
    // --- Codespace lifecycle ---

    case 'navvi_codespaces_list': {
      const output = sh(`gh cs list --repo ${REPO} --json name,state,createdAt,machine -q '.[] | "\\(.name)  \\(.state)  \\(.machine.displayName // "unknown")  \\(.createdAt)"'`);
      if (!output) return `No Codespaces found for ${REPO}.\nCreate one with navvi_codespace_start.`;
      return `Navvi Codespaces:\n${output}`;
    }

    case 'navvi_codespace_start': {
      if (args.name) {
        // Resume existing
        sh(`gh cs start -c ${args.name}`);
        return `Started Codespace: ${args.name}\nConnect with navvi_codespace_connect.`;
      }
      // Create new
      const output = sh(`gh cs create --repo ${REPO} --machine ${MACHINE_TYPE} --json name -q '.name'`);
      return `Created Codespace: ${output}\nConnect with navvi_codespace_connect.`;
    }

    case 'navvi_codespace_stop': {
      let csName = args.name;
      if (!csName) {
        csName = sh(`gh cs list --repo ${REPO} --json name,state -q '.[] | select(.state=="Available") | .name' | head -1`);
      }
      if (!csName) return 'No running Codespace found.';
      sh(`gh cs stop -c ${csName}`);
      // Also disconnect if forwarding
      if (fs.existsSync(PIDFILE)) {
        try {
          const pid = fs.readFileSync(PIDFILE, 'utf8').trim();
          process.kill(parseInt(pid));
        } catch {}
        fs.unlinkSync(PIDFILE);
      }
      return `Stopped Codespace: ${csName}`;
    }

    case 'navvi_codespace_connect': {
      // Kill existing forward if any
      if (fs.existsSync(PIDFILE)) {
        try {
          const pid = fs.readFileSync(PIDFILE, 'utf8').trim();
          process.kill(parseInt(pid));
        } catch {}
        fs.unlinkSync(PIDFILE);
      }

      let csName = args.name;
      if (!csName) {
        csName = sh(`gh cs list --repo ${REPO} --json name,state -q '.[] | select(.state=="Available") | .name' | head -1`);
      }
      if (!csName) return 'No running Codespace found. Start one with navvi_codespace_start.';

      // Start port forward in background
      const child = spawn('gh', ['cs', 'ports', 'forward', `${PINCHTAB_PORT}:${PINCHTAB_PORT}`, '-c', csName], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      fs.writeFileSync(PIDFILE, String(child.pid));

      // Wait a moment for the tunnel to establish
      await new Promise((r) => setTimeout(r, 3000));

      const reachable = isPinchtabReachable();
      return `Connected to ${csName}\n  Port forward: localhost:${PINCHTAB_PORT} → Codespace\n  PinchTab: ${reachable ? 'reachable' : 'not yet reachable (PinchTab may need to be started inside the Codespace)'}`;
    }

    case 'navvi_codespace_disconnect': {
      if (!fs.existsSync(PIDFILE)) return 'No active port forward.';
      try {
        const pid = fs.readFileSync(PIDFILE, 'utf8').trim();
        process.kill(parseInt(pid));
        fs.unlinkSync(PIDFILE);
        return 'Disconnected. Port forward stopped.';
      } catch (e) {
        fs.unlinkSync(PIDFILE);
        return `Disconnected (process may have already exited).`;
      }
    }

    // --- Browser control (PinchTab) ---

    case 'navvi_up': {
      const { persona, mode = 'headed' } = args;
      const result = await apiCall('POST', '/instances/launch', {
        name: persona,
        mode,
        profile: `.navvi/profiles/${persona}`,
      });
      return `Instance launched: ${result.id || JSON.stringify(result)}`;
    }

    case 'navvi_down': {
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

    case 'navvi_status': {
      const connected = isPinchtabReachable();
      let status = `PinchTab: ${connected ? 'connected' : 'not connected'}`;
      if (fs.existsSync(PIDFILE)) {
        status += ` (port forward PID: ${fs.readFileSync(PIDFILE, 'utf8').trim()})`;
      }
      if (connected) {
        try {
          const instances = await apiCall('GET', '/instances');
          if (Array.isArray(instances) && instances.length > 0) {
            status += '\n\nRunning instances:\n' +
              instances.map((i) => `  ${i.name} — ${i.id} (${i.mode || 'unknown'})`).join('\n');
          } else {
            status += '\n\nNo browser instances running. Launch one with navvi_up.';
          }
        } catch {
          status += '\n\nCould not list instances.';
        }
      }
      return status;
    }

    case 'navvi_open': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance. Use navvi_up first.';
      const result = await apiCall('POST', `/instances/${instId}/tabs/open`, { url: args.url });
      return `Opened ${args.url}` + (result.id ? ` (tab: ${result.id})` : '');
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
        http.get(url, (res) => {
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
          serverInfo: { name: 'navvi', version: '0.2.0' },
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

// Cleanup port forward on exit
process.on('exit', () => {
  if (fs.existsSync(PIDFILE)) {
    try {
      process.kill(parseInt(fs.readFileSync(PIDFILE, 'utf8').trim()));
      fs.unlinkSync(PIDFILE);
    } catch {}
  }
});

process.stderr.write('Navvi MCP server started (v0.2.0)\n');
