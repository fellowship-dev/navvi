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
 * - `/login/`, `/login/index-renamed.html`, `/login/account.html` (cookie-gated), `POST /login`;
 *   `switchLogin("renamed")` serves the renamed form (button "Sign in") at `/login/` (heal proof for a trace step)
 * - `/login-otp/` a two-step login (U16): email and password (`POST /login-otp`), then `/login-otp/verify` asks for a
 *   one-time code (`POST /login-otp/verify`) and `/login-otp/account` opens only when the code equals `expectOtp(code)`;
 *   `lastOtp()` is the code the site last received
 * - `/demo/pharmacy[-v1|-v2]/producto/challenge-<anything>.html`  a product URL answered by the bot challenge (503):
 *   a store that challenges some requests of a template it serves
 * - `/demo/pharmacy[-v1|-v2]/producto/error-<anything>.html`  the store's error template with status 500
 * - `/demo/pharmacy[-v1|-v2]/producto/retirado-<anything>.html`  redirects (302) to the store's index: a retired product
 * - `/demo/pharmacy[-v1|-v2]/producto/sin-precio-<slug>.html`  that product page with its price removed:
 *   a healthy page on which one field is empty by design (an undiscounted product has no list price)
 * - `/demo/pharmacy[-v1|-v2]/producto/tardio-<slug>.html`  a single-page app still rendering: a spinner, a location
 *   modal carrying a reCAPTCHA widget and almost no text, then that product's page ~1.5 s later (the widget stays)
 * - `/demo/pharmacy[-v1|-v2]/producto/cargando-<slug>.html`  the same app, whose spinner never finishes
 * - `/demo/pharmacy[-v1|-v2]/producto/rediseno-<slug>.html`  that product page in a second layout whose price markup
 *   was renamed: the price selector breaks on it while every other field still reads
 * - `/demo/ficha-red/producto.html?sku=<sku>`  a product page whose name and price arrive only in the JSON it fetches
 *   (`/demo/ficha-red/payload-<sku>.json`); a `sku` starting `sin-carga-` gets a 404 for its payload
 * - `/fixtures/<name>.html`   from tests/fixtures; `challenge.html` is served with status 503
 * - `/demo/buscador/buscar?q=<q>[&page=<n>]`  a store's search results (see `searchPage`): three pages of items
 *   that depend on `q`, one product found by every query; `q` starting `error-` answers 500, `gone-` 404,
 *   `challenge-` the bot challenge (503), `retirado-` redirects (302) off the template to `/demo/buscador/`,
 *   `sin-resultados-` a "no results" page whose recommendations sit outside the results list
 */

export type DemoVersion = "v1" | "v2";
export type LoginVersion = "normal" | "renamed";

export interface FixtureServer {
  baseUrl: string;
  switchDemo(version: DemoVersion): void;
  currentDemo(): DemoVersion;
  switchLogin(version: LoginVersion): void;
  /** The one-time code `/login-otp/verify` accepts; null accepts none. */
  expectOtp(code: string | null): void;
  /** The code last posted to `/login-otp/verify`. */
  lastOtp(): string | null;
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
  let login: LoginVersion = "normal";
  let expectedOtp: string | null = null;
  let receivedOtp: string | null = null;

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
      if (pathname.startsWith("/login-otp")) {
        const cookies = req.headers.cookie ?? "";
        if (pathname === "/login-otp" && method === "POST") {
          const params = new URLSearchParams(await readBody(req));
          if ((params.get("password") ?? "").length > 0) redirect(res, "/login-otp/verify", { "Set-Cookie": "otp_pending=1; Path=/; HttpOnly" });
          else redirect(res, "/login-otp/");
          return;
        }
        if (pathname === "/login-otp/verify" && method === "POST") {
          receivedOtp = new URLSearchParams(await readBody(req)).get("otp");
          if (expectedOtp !== null && receivedOtp === expectedOtp) redirect(res, "/login-otp/account", { "Set-Cookie": "otp_session=ok; Path=/; HttpOnly" });
          else redirect(res, "/login-otp/verify?error=1");
          return;
        }
        if (pathname === "/login-otp/verify") return void sendHtml(res, 200, otpVerifyPage(url.searchParams.has("error")));
        if (pathname === "/login-otp/account") {
          if (!cookies.includes("otp_session=ok")) return void redirect(res, "/login-otp/");
          return void sendHtml(res, 200, `<!doctype html><title>Account</title><h1>Your account</h1><p>Signed in with two steps.</p>`);
        }
        return void sendHtml(res, 200, OTP_LOGIN_PAGE);
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
        const file = resolveWithin(path.join(DEMO_DIR, "login"), rest || (login === "renamed" ? "index-renamed.html" : "index.html"));
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

      // A frame that never answers, so a page embedding it never fires `load`.
      if (pathname === "/demo/buscador/colgado") return;
      // A store's search: one template (`/demo/buscador/buscar`), items that depend on `q`.
      if (pathname === "/demo/buscador/buscar" || pathname === "/demo/buscador/" || pathname === "/demo/buscador") {
        const q = url.searchParams.get("q") ?? "";
        if (pathname !== "/demo/buscador/buscar") return void sendHtml(res, 200, "<!doctype html><title>Tienda</title><h1>Tienda de ejemplo</h1><p>Categorías</p>");
        if (q.startsWith("error-")) return void sendHtml(res, 500, "<!doctype html><title>Error</title><h1>¡Lo sentimos!</h1><p>Intente más tarde.</p>");
        if (q.startsWith("gone-")) return void sendHtml(res, 404, "<!doctype html><title>No encontrado</title><h1>Página no encontrada</h1>");
        if (q.startsWith("challenge-")) return void (await sendFile(res, path.join(FIXTURES_DIR, "challenge.html"), 503));
        if (q.startsWith("retirado-")) return void redirect(res, "/demo/buscador/");
        // A search that found nothing on a store whose page carries a reCAPTCHA
        // widget and little text: it reads like a weak challenge (2026-09-30).
        if (q.startsWith("vacio-widget-")) return void sendHtml(res, 200, `<!doctype html><title>Buscar</title><h1>Resultados</h1><ul class="resultados"></ul><div class="g-recaptcha" data-sitekey="ejemplo"></div>`);
        // A results page whose items a script mounts ~1.5 s after the document (an instant-search front end).
        if (q.startsWith("tarde-")) {
          const list = /<ul class="resultados">([\s\S]*?)<\/ul>/.exec(searchPage(q, 1))?.[1] ?? "";
          return void sendHtml(res, 200, `<!doctype html><title>Buscar ${q}</title><h1>Resultados</h1><ul class="resultados"></ul><script>setTimeout(()=>{document.querySelector("ul.resultados").innerHTML=${JSON.stringify(list)}},1500)</script>`);
        }
        // A results page whose `load` never fires: an embedded frame that never answers.
        if (q.startsWith("lento-")) return void sendHtml(res, 200, `${searchPage(q, 1)}<iframe src="/demo/buscador/colgado"></iframe>`);
        return void sendHtml(res, 200, searchPage(q, Number(url.searchParams.get("page") ?? "1")));
      }

      // Pharmacy demo, version-switched or explicit.
      const pharmacy = /^\/demo\/pharmacy(?:-(v1|v2))?(\/.*)?$/.exec(pathname);
      if (pharmacy) {
        if (/^\/producto\/challenge-[^/]+\.html$/.test(pharmacy[2] ?? "")) {
          await sendFile(res, path.join(FIXTURES_DIR, "challenge.html"), 503);
          return;
        }
        const version = (pharmacy[1] as DemoVersion | undefined) ?? demo;
        if (/^\/producto\/error-[^/]+\.html$/.test(pharmacy[2] ?? "")) {
          res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
          res.end("<!doctype html><title>Error</title><h1>¡Lo sentimos!</h1><p>No se encontró la página que solicitó.</p>");
          return;
        }
        if (/^\/producto\/retirado-[^/]+\.html$/.test(pharmacy[2] ?? "")) {
          redirect(res, pathname.replace(/\/producto\/[^/]+$/, "/index.html"));
          return;
        }
        const rendering = /^\/producto\/(tardio|cargando)-([^/]+\.html)$/.exec(pharmacy[2] ?? "");
        if (rendering) {
          const source = resolveWithin(path.join(DEMO_DIR, `pharmacy-${version}`), `/producto/${rendering[2]}`);
          if (!source) return void notFound(res);
          const body = /<body>([\s\S]*)<\/body>/.exec(await fs.readFile(source, "utf8"))?.[1] ?? "";
          return void sendHtml(res, 200, renderingApp(rendering[1] === "tardio" ? body : null));
        }
        const redesigned = /^\/producto\/rediseno-([^/]+\.html)$/.exec(pharmacy[2] ?? "");
        if (redesigned) {
          const source = resolveWithin(path.join(DEMO_DIR, `pharmacy-${version}`), `/producto/${redesigned[1]}`);
          if (!source) return void notFound(res);
          const page = (await fs.readFile(source, "utf8")).replace(/producto-precio/g, "ficha-importe").replace(/class="precio"/g, 'class="importe"');
          return void sendHtml(res, 200, page);
        }
        const priceless = /^\/producto\/sin-precio-([^/]+\.html)$/.exec(pharmacy[2] ?? "");
        if (priceless) {
          const source = resolveWithin(path.join(DEMO_DIR, `pharmacy-${version}`), `/producto/${priceless[1]}`);
          if (!source) return void notFound(res);
          const page = (await fs.readFile(source, "utf8")).replace(/<div class="producto-precio">[\s\S]*?<\/div>/, "");
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(page);
          return;
        }
        const file = resolveWithin(path.join(DEMO_DIR, `pharmacy-${version}`), pharmacy[2] || "/index.html");
        if (!file) return void notFound(res);
        await sendFile(res, file);
        return;
      }

      // A product page that reads its name and price from the payload it fetches for itself.
      if (pathname === "/demo/ficha-red/producto.html") return void sendHtml(res, 200, payloadPage(url.searchParams.get("sku") ?? ""));
      const payload = /^\/demo\/ficha-red\/payload-([^/]+)\.json$/.exec(pathname);
      if (payload) {
        const sku = payload[1]!;
        if (sku.startsWith("sin-carga-")) return void notFound(res);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ productData: { name: `Producto ${sku}`, prices: { list: 4690 } } }));
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
    switchLogin(version) {
      login = version;
    },
    expectOtp(code) {
      expectedOtp = code;
    },
    lastOtp: () => receivedOtp,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const OTP_LOGIN_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Member login</title></head><body>
<h1>Member login</h1>
<form method="post" action="/login-otp">
  <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Log in</button>
</form></body></html>`;

function otpVerifyPage(error: boolean): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Two-step verification</title></head><body>
<h1>Two-step verification</h1>${error ? '<p role="alert">That code did not work.</p>' : ""}
<p>Enter the code from your authenticator app.</p>
<form method="post" action="/login-otp/verify">
  <label for="otp">Verification code</label><input id="otp" name="otp" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
  <label for="note">Note</label><textarea id="note" name="note"></textarea>
  <button type="submit">Verify</button>
</form></body></html>`;
}

function sendHtml(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/** Pages a search result list has before its next link disappears. */
export const SEARCH_PAGES = 3;

/**
 * One page of search results for `q`: two items named after the query and the
 * page, and on page 1 a product every query finds (`Suero fisiológico`). A
 * `sin-resultados-` query is the "no results" page stores serve, recommending
 * products in a block of its own.
 */
export function searchPage(q: string, page: number): string {
  const card = (name: string, slug: string) => `<li class="producto"><h2><a href="/demo/buscador/producto/${slug}.html">${name}</a></h2><span class="precio">$1.990</span></li>`;
  if (q.startsWith("sin-resultados-")) {
    return `<!doctype html><title>Buscar</title><h1>No encontramos resultados para "${q}"</h1><ul class="resultados"></ul>
<section class="recomendados"><h2>Te puede interesar</h2><ul><li class="recomendado"><h2><a href="/demo/buscador/producto/vitamina-c.html">Vitamina C</a></h2></li></ul></section>`;
  }
  const items = [card(`${q} ${page}0 mg`, `${q}-${page}0-mg`), card(`${q} ${page}5 mg`, `${q}-${page}5-mg`)];
  if (page === 1) items.push(card("Suero fisiológico", "suero-fisiologico"));
  const next = page < SEARCH_PAGES ? `<a class="siguiente" href="/demo/buscador/buscar?q=${encodeURIComponent(q)}&page=${page + 1}">Siguiente</a>` : "";
  return `<!doctype html><title>Buscar ${q}</title><h1>Resultados para "${q}"</h1><ul class="resultados">${items.join("")}</ul>${next}`;
}

/**
 * A single-page app mid-render, the shape a store's front end has before its
 * bundle answers: a spinner, a location modal that loads a reCAPTCHA widget,
 * almost no text and no declared product. With `rendered`, that markup is
 * mounted ~1.5 s later and the modal stays; with null the spinner never ends.
 * The script is inline, so the shell rule (which counts script bundles) does
 * not claim it.
 */
export function renderingApp(rendered: string | null): string {
  const mount = rendered === null ? "" : `<script>setTimeout(() => { document.getElementById("app").innerHTML = ${JSON.stringify(rendered).replace(/</g, "\\u003c")}; }, 1500);</script>`;
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Farmacia</title></head><body>
<div id="app"><div class="spinner" aria-busy="true">Cargando…</div></div>
<div class="modal-ubicacion"><p>Selecciona tu comuna</p><div class="g-recaptcha" data-sitekey="ejemplo"></div></div>
${mount}</body></html>`;
}

/** A product page whose name and price are stated only in `/demo/ficha-red/payload-<sku>.json`. */
export function payloadPage(sku: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Producto</title></head><body>
<h1 id="nombre">Cargando…</h1><p>Los datos de esta ficha llegan en la respuesta que la página pide para sí misma.</p>
<script>
fetch("/demo/ficha-red/payload-${encodeURIComponent(sku)}.json")
  .then((response) => response.json())
  .then((payload) => { document.getElementById("nombre").textContent = payload.productData.name; })
  .catch(() => { document.getElementById("nombre").textContent = "Ficha sin respuesta"; });
</script></body></html>`;
}

function notFound(res: http.ServerResponse): void {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("not found");
}
