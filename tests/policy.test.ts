import { describe, expect, it } from "vitest";
import {
  allowedControl,
  isAllowedRequestUrl,
  isAllowedUrl,
  isModelTextAllowed,
  isOnAllowedDomain,
  isSecretCapable,
  makeHostCheck,
  registrableDomain,
  type Control,
} from "../src/browser/policy.js";
import { isPrivateAddress, isPrivateHostname } from "../src/input/schema.js";

const noMutations = { allowMutations: [] as string[] };
const postForm = (hasTypedText: boolean): Control => ({
  role: "button",
  name: "Search",
  tag: "button",
  form: { method: "post", hasTypedText, hasPasswordField: false, hasPaymentField: false },
});

describe("allowedControl (R38, KTD14)", () => {
  it("store: refuses a POST submit with no typed text, allows it once text was typed", () => {
    expect(allowedControl(postForm(false), "store", noMutations).allowed).toBe(false);
    expect(allowedControl(postForm(true), "store", noMutations).allowed).toBe(true);
  });

  it("store: refuses deny-listed names in English and Spanish, allows a plain link", () => {
    expect(allowedControl({ role: "button", name: "Delete account" }, "store", noMutations)).toMatchObject({ allowed: false });
    expect(allowedControl({ role: "button", name: "Eliminar cuenta" }, "store", noMutations)).toMatchObject({ allowed: false });
    expect(allowedControl({ role: "link", name: "Cerrar sesión" }, "store", noMutations).allowed).toBe(false);
    expect(allowedControl({ role: "link", name: "Next page" }, "store", noMutations)).toEqual({ allowed: true });
  });

  it("local: allows the POST submit, still refuses Delete account, Checkout only with allowMutations", () => {
    expect(allowedControl(postForm(false), "local", noMutations).allowed).toBe(true);
    expect(allowedControl({ role: "button", name: "Delete account" }, "local", noMutations).allowed).toBe(false);
    expect(allowedControl({ role: "button", name: "Checkout" }, "local", noMutations).allowed).toBe(false);
    expect(allowedControl({ role: "button", name: "Checkout" }, "local", { allowMutations: ["checkout"] }).allowed).toBe(true);
    expect(allowedControl({ role: "button", name: "Checkout" }, "store", { allowMutations: ["checkout"] }).allowed).toBe(false);
  });

  it("refuses a payment field and a submit in a payment form in both profiles, even with allowMutations", () => {
    const card: Control = { role: "textbox", name: "Card number", tag: "input", inputType: "text", autocomplete: "cc-number" };
    const payForm: Control = { ...postForm(true), name: "Pay", form: { method: "post", hasTypedText: true, hasPasswordField: false, hasPaymentField: true } };
    for (const profile of ["store", "local"] as const) {
      expect(allowedControl(card, profile, { allowMutations: ["pay"] }).allowed).toBe(false);
      expect(allowedControl(payForm, profile, { allowMutations: ["pay"] }).allowed).toBe(false);
    }
  });

  it("never offers password, file or hidden inputs (R24); password is secret-capable", () => {
    const pw: Control = { role: "textbox", name: "Password", tag: "input", inputType: "password" };
    expect(allowedControl(pw, "local", noMutations).allowed).toBe(false);
    expect(allowedControl({ role: "textbox", name: "Upload", tag: "input", inputType: "file" }, "local", noMutations).allowed).toBe(false);
    expect(allowedControl({ role: "textbox", name: "csrf", tag: "input", inputType: "hidden" }, "local", noMutations).allowed).toBe(false);
    expect(isSecretCapable(pw)).toBe(true);
    expect(isSecretCapable({ role: "textbox", name: "Email", tag: "input", inputType: "email" })).toBe(false);
  });

  // The deny lists are not asserted as literals: "Delete account"/"Eliminar cuenta",
  // "Cerrar sesión" and "Checkout" are each refused by the tests above.
});

describe("url guard (R26)", () => {
  // The last two came from smoke.test.ts, whose copy of this table asserted isAllowedUrl only.
  it.each(["file:///etc/passwd", "http://169.254.169.254/", "http://localhost:9222/json", "javascript:alert(1)", "http://box.internal/", "http://10.0.0.5/", "http://[::1]/"])(
    "rejects %s",
    (url) => {
      expect(isAllowedUrl(url)).toBe(false);
      expect(isAllowedRequestUrl(url, [])).toBe(false);
    },
  );
  it("passes a public host, and 127.0.0.1 only when allowlisted", () => {
    expect(isAllowedUrl("https://news.ycombinator.com/")).toBe(true);
    expect(isAllowedUrl("http://127.0.0.1:4321/fixture", ["127.0.0.1"])).toBe(true);
    expect(isAllowedRequestUrl("https://news.ycombinator.com/", [])).toBe(true);
    expect(isAllowedRequestUrl("http://127.0.0.1:4321/fixture", [])).toBe(false);
    expect(isAllowedRequestUrl("http://127.0.0.1:4321/fixture", ["127.0.0.1"])).toBe(true);
  });
});

/**
 * U11 / R15: host classification over parsed addresses, not string prefixes.
 * The old table let IPv4-mapped IPv6, the unspecified address, CGNAT,
 * multicast and `localhost.` through, and refused any public name starting
 * with "fc" or "fd".
 */
describe("url guard: parsed-address classification (R15)", () => {
  it.each([
    "http://[::ffff:a9fe:a9fe]/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/",
    "http://[::]/",
    "http://0.0.0.0/",
    "http://100.64.0.1/",
    "http://100.127.255.254/",
    "http://224.0.0.1/",
    "http://239.255.255.250/",
    "http://255.255.255.255/",
    "http://240.0.0.1/",
    "http://198.18.0.1/",
    "http://192.0.0.8/",
    "http://0x7f.1/",
    "http://2130706433/",
    "http://127.0.0.1./",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://x.localhost/",
    "http://a.b.localhost./",
    "http://[fe80::1]/",
    "http://[febf::1]/",
    "http://[fc00::1]/",
    "http://[fd12:3456::1]/",
    "http://[ff02::1]/",
    "http://[::127.0.0.1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
    "http://[2002:a9fe:a9fe::1]/",
    "http://printer.local/",
    "http://box.internal/",
  ])("refuses %s", (url) => {
    expect(isAllowedUrl(url)).toBe(false);
    expect(isAllowedRequestUrl(url, [])).toBe(false);
  });

  it.each(["https://fcexample.com/", "https://fdexample.org/", "https://fe80example.net/", "https://localhost.example.com/", "https://example.com./", "http://100.63.255.255/", "http://100.128.0.1/", "http://8.8.8.8/", "http://[2606:4700:4700::1111]/", "http://[::ffff:8.8.8.8]/"])(
    "allows the public host %s",
    (url) => {
      expect(isAllowedUrl(url)).toBe(true);
    },
  );

  it("classifies raw resolver answers, IPv4, IPv6 and mapped", () => {
    for (const ip of ["10.0.0.5", "172.16.0.1", "192.168.1.1", "169.254.169.254", "::1", "::ffff:10.0.0.5", "::ffff:a00:5", "fe80::1", "fd00::1"]) expect(isPrivateAddress(ip), ip).toBe(true);
    for (const ip of ["93.184.216.34", "2606:4700::1", "::ffff:93.184.216.34"]) expect(isPrivateAddress(ip), ip).toBe(false);
    // Not an address at all: fail closed.
    expect(isPrivateAddress("not-an-ip")).toBe(true);
    expect(isPrivateHostname("fcexample.com")).toBe(false);
    expect(isPrivateHostname("localhost.")).toBe(true);
  });
});

/**
 * U11 / R15, KTD12: a public name that resolves to a private address is
 * refused. The lookup is cached per host and fails closed.
 */
describe("url guard: DNS check (R15, KTD12)", () => {
  const resolverFor = (answers: Record<string, string[] | Error>) => {
    const calls: string[] = [];
    const resolve = async (host: string): Promise<string[]> => {
      calls.push(host);
      const answer = answers[host];
      if (answer === undefined) throw new Error(`ENOTFOUND ${host}`);
      if (answer instanceof Error) throw answer;
      return answer;
    };
    return { resolve, calls };
  };

  it("refuses a public name resolving to 10.0.0.5, allows one resolving to a public address, and caches per host", async () => {
    const { resolve, calls } = resolverFor({ "rebind.example.com": ["93.184.216.34", "10.0.0.5"], "shop.example.com": ["93.184.216.34", "2606:4700::1"] });
    const check = makeHostCheck([], resolve);
    expect(await check("https://rebind.example.com/")).toBe(false);
    expect(await check("https://shop.example.com/a")).toBe(true);
    expect(await check("https://shop.example.com/b")).toBe(true);
    expect(calls.filter((h) => h === "shop.example.com")).toHaveLength(1);
  });

  it("fails closed: a resolver error or an empty answer refuses", async () => {
    const { resolve } = resolverFor({ "down.example.com": new Error("EAI_AGAIN"), "empty.example.com": [] });
    const check = makeHostCheck([], resolve);
    expect(await check("https://down.example.com/")).toBe(false);
    expect(await check("https://empty.example.com/")).toBe(false);
    expect(await check("https://unknown.example.com/")).toBe(false);
  });

  it("does not resolve IP literals, in-page schemes or allowlisted hosts; allowPrivateHosts still permits the fixture host", async () => {
    const { resolve, calls } = resolverFor({ "fixture.test": ["127.0.0.1"] });
    const check = makeHostCheck(["127.0.0.1", "fixture.test"], resolve);
    expect(await check("http://127.0.0.1:4321/fixture")).toBe(true);
    expect(await check("http://fixture.test:4321/fixture")).toBe(true);
    expect(await check("data:text/plain,x")).toBe(true);
    expect(await check("http://93.184.216.34/")).toBe(true);
    expect(calls).toEqual([]);
    // Without the allowlist the same name is refused by what it resolves to.
    expect(await makeHostCheck([], resolve)("http://fixture.test:4321/")).toBe(false);
  });
});

describe("domain rule (R25)", () => {
  const start = ["https://www.example.com/jobs"];
  it("accepts subdomains of the start host and hosts in allowedDomains, rejects others", () => {
    expect(isOnAllowedDomain("https://jobs.example.com/1", start, [])).toBe(true);
    expect(isOnAllowedDomain("https://example.com/", start, [])).toBe(true);
    expect(isOnAllowedDomain("https://cdn.partner.io/x", start, ["partner.io"])).toBe(true);
    expect(isOnAllowedDomain("https://evil.com/", start, [])).toBe(false);
    expect(isOnAllowedDomain("https://example.com.evil.com/", start, [])).toBe(false);
    expect(isOnAllowedDomain("javascript:alert(1)", start, [])).toBe(false);
  });
  it("computes registrable domains with the second-level suffix heuristic", () => {
    expect(registrableDomain("shop.example.co.uk")).toBe("example.co.uk");
    expect(registrableDomain("www.farmacia.cl")).toBe("farmacia.cl");
    expect(registrableDomain("a.b.example.com.au")).toBe("example.com.au");
    expect(registrableDomain("example.com")).toBe("example.com");
  });
});

describe("model text (R24)", () => {
  const search: Control = { role: "textbox", name: "Search", tag: "input", inputType: "text" };
  it("rejects emails, phone numbers and card numbers; accepts a query", () => {
    expect(isModelTextAllowed(search, "a@b.com")).toBe(false);
    expect(isModelTextAllowed(search, "+56 9 1234 5678")).toBe(false);
    expect(isModelTextAllowed(search, "4111 1111 1111 1111")).toBe(false);
    expect(isModelTextAllowed(search, "python jobs")).toBe(true);
  });
  it("lets dates, compact date stamps and order numbers through while still rejecting phone numbers", () => {
    for (const text of ["2026-09-19", "20260919", "ORD-12345678", "order 987654321", "2026-09-19T10:30:00"]) {
      expect(isModelTextAllowed(search, text), text).toBe(true);
    }
    for (const text of ["+56 9 1234 5678", "(02) 2345 6789", "912 345 678", "+1 (415) 555-0123", "0800-123-456"]) {
      expect(isModelTextAllowed(search, text), text).toBe(false);
    }
  });
  it("never types model text into personal-data fields", () => {
    expect(isModelTextAllowed({ ...search, autocomplete: "email" }, "python jobs")).toBe(false);
    expect(isModelTextAllowed({ ...search, nameAttr: "phone_number" }, "python jobs")).toBe(false);
    expect(isModelTextAllowed({ ...search, autocomplete: "cc-name" }, "Max")).toBe(false);
  });
});
