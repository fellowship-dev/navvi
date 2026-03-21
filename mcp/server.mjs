#!/usr/bin/env node
/**
 * Navvi MCP Server — wraps PinchTab HTTP API as MCP tools.
 *
 * Exposes browser control tools to Claude Code:
 *   navvi_up, navvi_down, navvi_status,
 *   navvi_open, navvi_snapshot, navvi_click, navvi_fill, navvi_screenshot
 *
 * Speaks MCP stdio protocol. Zero dependencies (Node built-ins only).
 */

const http = require('http');

const PINCHTAB_API = process.env.PINCHTAB_API || 'http://127.0.0.1:9867';

// --- HTTP helper (no deps) ---

function apiCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, PINCHTAB_API);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method,
      headers: { 'Content-Type': 'application/json' },
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
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
  {
    name: 'navvi_up',
    description: 'Launch a browser instance for a persona. Returns instance ID.',
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
    description: 'List all running browser instances.',
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
      const instances = await apiCall('GET', '/instances');
      if (!Array.isArray(instances) || instances.length === 0) return 'No running instances.';
      return instances.map((i) => `${i.name} — ${i.id} (${i.mode || 'unknown'})`).join('\n');
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
      const result = await apiCall('POST', `/tabs/${tabId}/action`, {
        type: 'click',
        ref: args.ref,
      });
      return `Clicked ${args.ref}`;
    }

    case 'navvi_fill': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      const result = await apiCall('POST', `/tabs/${tabId}/action`, {
        type: 'fill',
        ref: args.ref,
        value: args.value,
      });
      return `Filled ${args.ref} with "${args.value}"`;
    }

    case 'navvi_screenshot': {
      const instId = await getFirstInstance();
      if (!instId) return 'Error: no running instance.';
      const tabId = await getFirstTab(instId);
      if (!tabId) return 'Error: no open tab.';
      // Get raw screenshot bytes
      return new Promise((resolve, reject) => {
        const url = new URL(`/tabs/${tabId}/screenshot`, PINCHTAB_API);
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

let buffer = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  // Process complete JSON-RPC messages (newline-delimited)
  const lines = buffer.split('\n');
  buffer = lines.pop(); // keep incomplete line in buffer
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (e) {
      // Skip malformed lines
    }
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
          serverInfo: { name: 'navvi', version: '0.1.0' },
        },
      });
      break;

    case 'notifications/initialized':
      // Client acknowledges init — no response needed
      break;

    case 'tools/list':
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      break;

    case 'tools/call': {
      const { name, arguments: args } = params;
      try {
        const result = await handleTool(name, args || {});
        if (typeof result === 'object' && result.type === 'image') {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [
                { type: 'image', data: result.data, mimeType: result.mimeType },
              ],
            },
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

process.stderr.write('Navvi MCP server started\n');
