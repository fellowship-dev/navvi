import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Dependency-free static server for the demo and fixture pages.
 *
 * URL layout:
 * - `/demo/pharmacy/...`      the pharmacy version selected with `switchDemo` (heal proof: same URLs, new markup)
 * - `/demo/pharmacy-v1/...`   and `/demo/pharmacy-v2/...` directly
 * - `/login/`, `/login/index-renamed.html`, `/login/account.html` (cookie-gated), `POST /login`
 * - `/fixtures/<name>.html`   from tests/fixtures; `challenge.html` is served with status 503
 */

export type DemoVersion = "v1" | "v2";

export interface FixtureServer {
  baseUrl: string;
  switchDemo(version: DemoVersion): void;
  currentDemo(): DemoVersion;
  close(): Promise<void>;
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEMO_DIR = path.join(REPO_ROOT, "demo");
const FIXTURES_DIR = path.join(REPO_ROOT, "tests", "fixtures");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function hasSessionCookie(req: http.IncomingMessage): boolean {
  const cookie = req.headers.cookie ?? "";
  return cookie.split(";").some((part) => part.trim() === "session=ok");
}

function redirect(res: http.ServerResponse, location: string, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(302, { Location: location, "Content-Type": "text/plain; charset=utf-8", ...extraHeaders });
  res.end(`Redirecting to ${location}`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Maps a URL path to a file inside `root`, refusing anything that escapes it. */
function resolveWithin(root: string, relative: string): string | null {
  const decoded = decodeURIComponent(relative);
  const target = path.resolve(root, "." + (decoded.startsWith("/") ? decoded : `/${decoded}`));
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  return target;
}

async function sendFile(res: http.ServerResponse, file: string, status = 200): Promise<void> {
  let target = file;
  try {
    const stat = await fs.stat(target);
    if (stat.isDirectory()) target = path.join(target, "index.html");
    const body = await fs.readFile(target);
    res.writeHead(status, { "Content-Type": MIME[path.extname(target)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

export async function startFixtureServer(): Promise<FixtureServer> {
  let demo: DemoVersion = "v1";

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    const method = (req.method ?? "GET").toUpperCase();

    try {
      // Login demo: POST /login sets the session cookie when the password is non-empty.
      if (pathname === "/login" && method === "POST") {
        const params = new URLSearchParams(await readBody(req));
        if ((params.get("password") ?? "").length > 0) {
          redirect(res, "/login/account.html", { "Set-Cookie": "session=ok; Path=/; HttpOnly" });
        } else {
          redirect(res, "/login/?error=1");
        }
        return;
      }
      if (pathname === "/login/logout") {
        redirect(res, "/login/", { "Set-Cookie": "session=; Path=/; Max-Age=0" });
        return;
      }
      const loginMatch = /^\/(?:demo\/)?login(?:\/(.*))?$/.exec(pathname);
      if (loginMatch) {
        const rest = loginMatch[1] ?? "";
        if (rest === "account.html" && !hasSessionCookie(req)) {
          redirect(res, "/login/");
          return;
        }
        const file = resolveWithin(path.join(DEMO_DIR, "login"), rest || "index.html");
        if (!file) return void notFound(res);
        await sendFile(res, file);
        return;
      }

      // Forms in fixtures post here; the body is irrelevant.
      if (pathname === "/jobs/filter" && method === "POST") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<!doctype html><title>Filtered</title><h1>All jobs</h1>");
        return;
      }

      // Pharmacy demo, version-switched or explicit.
      const pharmacy = /^\/demo\/pharmacy(?:-(v1|v2))?(\/.*)?$/.exec(pathname);
      if (pharmacy) {
        const version = (pharmacy[1] as DemoVersion | undefined) ?? demo;
        const file = resolveWithin(path.join(DEMO_DIR, `pharmacy-${version}`), pharmacy[2] || "/index.html");
        if (!file) return void notFound(res);
        await sendFile(res, file);
        return;
      }

      const fixture = /^\/fixtures(\/.*)?$/.exec(pathname);
      if (fixture) {
        const file = resolveWithin(FIXTURES_DIR, fixture[1] || "/");
        if (!file) return void notFound(res);
        const status = path.basename(file) === "challenge.html" ? 503 : 200;
        await sendFile(res, file, status);
        return;
      }

      const other = resolveWithin(DEMO_DIR, pathname);
      if (other && pathname.startsWith("/demo/")) {
        await sendFile(res, other);
        return;
      }
      notFound(res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(error));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    switchDemo(version) {
      demo = version;
    },
    currentDemo: () => demo,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}
