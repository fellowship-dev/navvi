import { describe, expect, it } from "vitest";
import {
  DENY_LIST_EN,
  DENY_LIST_ES,
  allowedControl,
  isAllowedRequestUrl,
  isAllowedUrl,
  isModelTextAllowed,
  isOnAllowedDomain,
  isSecretCapable,
  registrableDomain,
  type Control,
} from "../src/browser/policy.js";

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

  it("exposes the deny lists", () => {
    expect(DENY_LIST_EN).toContain("checkout");
    expect(DENY_LIST_ES).toContain("cerrar sesión");
  });
});

describe("url guard (R26)", () => {
  it.each(["file:///etc/passwd", "http://169.254.169.254/", "http://localhost:9222/json", "javascript:alert(1)", "http://box.internal/"])(
    "rejects %s",
    (url) => {
      expect(isAllowedUrl(url)).toBe(false);
      expect(isAllowedRequestUrl(url, [])).toBe(false);
    },
  );
  it("passes a public host, and 127.0.0.1 only when allowlisted", () => {
    expect(isAllowedRequestUrl("https://news.ycombinator.com/", [])).toBe(true);
    expect(isAllowedRequestUrl("http://127.0.0.1:4321/fixture", [])).toBe(false);
    expect(isAllowedRequestUrl("http://127.0.0.1:4321/fixture", ["127.0.0.1"])).toBe(true);
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
  it("never types model text into personal-data fields", () => {
    expect(isModelTextAllowed({ ...search, autocomplete: "email" }, "python jobs")).toBe(false);
    expect(isModelTextAllowed({ ...search, nameAttr: "phone_number" }, "python jobs")).toBe(false);
    expect(isModelTextAllowed({ ...search, autocomplete: "cc-name" }, "Max")).toBe(false);
  });
});
