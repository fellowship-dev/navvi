import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MissingSecretError, Secret, findPlaceholders, resolveSecrets, secretEnvName, type CommandRunner } from "../src/secrets/resolve.js";
import { loginFixture } from "./scraper-schema.test.js";

describe("Secret (R39)", () => {
  it("never renders its value through toString, JSON or inspect", () => {
    const s = new Secret("hunter2");
    expect(String(s)).toBe("[secret]");
    expect(`${s}`).toBe("[secret]");
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(inspect(s)).toBe("[secret]");
    expect(s.reveal()).toBe("hunter2");
    expect(Object.keys(s)).toEqual([]);
  });
});

describe("findPlaceholders", () => {
  it("finds {{secret:name}} in text, de-duplicated and in order", () => {
    expect(findPlaceholders("log in with {{secret:password}} and {{secret:otp}} then {{secret:password}}")).toEqual(["password", "otp"]);
    expect(findPlaceholders("")).toEqual([]);
    expect(findPlaceholders(undefined)).toEqual([]);
  });

  it("finds the secret names of a compiled scraper's type steps", () => {
    expect(findPlaceholders(loginFixture())).toEqual(["password"]);
  });

  it("merges several sources", () => {
    expect(findPlaceholders(["{{secret:a}}", loginFixture(), "{{secret:a}} {{secret:b}}"])).toEqual(["a", "password", "b"]);
  });
});

describe("resolveSecrets", () => {
  it("maps names to env variables as NAVVI_SECRET_<NAME>", () => {
    expect(secretEnvName("password")).toBe("NAVVI_SECRET_PASSWORD");
    expect(secretEnvName("api-key")).toBe("NAVVI_SECRET_API_KEY");
  });

  it("resolves in order: input map, env, keychain, apify", async () => {
    const runCommand: CommandRunner = vi.fn(async (_cmd: string, args: readonly string[]) => (args.includes("kc") ? "from-keychain" : null));
    const apify = vi.fn(async (name: string) => (name === "ap" ? "from-apify" : null));
    const out = await resolveSecrets(["one", "two", "kc", "ap"], {
      input: { one: "from-input", two: "input-wins" },
      env: { NAVVI_SECRET_TWO: "from-env", NAVVI_SECRET_KC: "" },
      platform: "darwin",
      runCommand,
      apify,
    });
    expect(out.get("one")?.reveal()).toBe("from-input");
    expect(out.get("two")?.reveal()).toBe("input-wins");
    expect(out.get("kc")?.reveal()).toBe("from-keychain");
    expect(out.get("ap")?.reveal()).toBe("from-apify");
    expect(runCommand).toHaveBeenCalledWith("security", ["find-generic-password", "-s", "navvi", "-a", "kc", "-w"]);
    expect(apify).toHaveBeenCalledTimes(1);
  });

  it("skips the keychain silently off macOS", async () => {
    const runCommand = vi.fn(async () => "never");
    await expect(resolveSecrets(["x"], { env: {}, platform: "linux", runCommand })).rejects.toBeInstanceOf(MissingSecretError);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("a missing secret names the placeholder and carries blocked_login_required", async () => {
    const promise = resolveSecrets(["password"], { env: {}, platform: "linux" });
    await expect(promise).rejects.toMatchObject({ name: "MissingSecretError", status: "blocked_login_required", placeholder: "password" });
    await expect(promise).rejects.toThrow(/\{\{secret:password\}\}/);
  });

  it("a keychain command failure is not fatal when a later source has the value", async () => {
    const runCommand: CommandRunner = async () => {
      throw new Error("security: not found");
    };
    const out = await resolveSecrets(["x"], { env: {}, platform: "darwin", runCommand, apify: async () => "v" });
    expect(out.get("x")?.reveal()).toBe("v");
  });
});
