import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ANTIGRAVITY_NEON_CLI, cliVersionAtLeast } from "@agenteschat/providers/plans";
import { AGY_PIN, AgyCopy, type AgyCopyOptions, agyPlatform } from "../../runner/agy-copy";
import { cliSpawn, pickedAgy, resolveCommand, setAgyPick } from "../../runner/executors";
import { removeDirs, tempDir } from "./helpers";

/*
 * The Antigravity CLI the runner brings (ADR 0143): a pinned build, checked against Google's SHA-512, used where the
 * person's own is older or missing and Gemini thinks on the computer.
 */

const dirs: string[] = [];
afterEach(() => {
  setAgyPick(undefined);
  removeDirs(dirs.splice(0));
});

/** A build like Google's: a tarball with one `antigravity` that says its version. */
function build(version: string) {
  const src = tempDir("agy-src-");
  dirs.push(src);
  writeFileSync(path.join(src, "antigravity"), `#!/bin/sh\necho "agy ${version}"\n`, { mode: 0o755 });
  const tarball = path.join(src, "cli.tar.gz");
  execFileSync("tar", ["-czf", tarball, "-C", src, "antigravity"]);
  const bytes = readFileSync(tarball);
  return { bytes, sha512: createHash("sha512").update(bytes).digest("hex") };
}

function copy(over: Partial<AgyCopyOptions> & { bytes?: Buffer; sha512?: string } = {}) {
  const home = tempDir("agy-home-");
  dirs.push(home);
  const made = over.bytes ? { bytes: over.bytes, sha512: over.sha512 ?? "" } : build("9.9.9");
  const fetched: string[] = [];
  const changes: number[] = [];
  const logs: string[] = [];
  const agy = new AgyCopy({
    home,
    log: (l) => logs.push(l),
    inUse: () => true,
    onChange: () => changes.push(1),
    pin: { version: "9.9.9", builds: { test: { url: "https://downloads.example/agy.tar.gz", sha512: made.sha512 } } },
    platform: "test",
    own: async () => null,
    fetch: (async (url: string) => {
      fetched.push(url);
      return new Response(made.bytes);
    }) as unknown as typeof fetch,
    ...over,
  });
  return { agy, home, fetched, changes, logs };
}

test("where Gemini thinks and the person has no agy: the pinned build, checked, runs every `agy`", async () => {
  const { agy, fetched, changes } = copy();
  await agy.check();
  expect(fetched).toEqual(["https://downloads.example/agy.tar.gz"]);
  expect(existsSync(agy.file())).toBe(true);
  expect(pickedAgy()).toBe(agy.file());
  expect(resolveCommand("agy")).toBe(agy.file());
  expect(execFileSync(agy.file(), { encoding: "utf8" }).trim()).toBe("agy 9.9.9");
  expect(changes).toHaveLength(1);
  // Already there: nothing downloaded again, nothing to tell.
  await agy.check();
  expect(fetched).toHaveLength(1);
  expect(changes).toHaveLength(1);
});

test("nothing downloaded where Gemini doesn't think and the person has no agy", async () => {
  const { agy, fetched } = copy({ inUse: () => false });
  await agy.check();
  expect(fetched).toHaveLength(0);
  expect(pickedAgy()).toBeUndefined();
});

test("the person's own agy: an older one is replaced for the runner, one at the pin or newer runs as it is", async () => {
  const older = copy({ inUse: () => false, own: async () => ({ file: "/usr/local/bin/agy", version: "agy 1.5.0" }) });
  await older.agy.check();
  expect(pickedAgy()).toBe(older.agy.file());
  setAgyPick(undefined);
  const newer = copy({ own: async () => ({ file: "/usr/local/bin/agy", version: "10.0.1" }) });
  await newer.agy.check();
  expect(newer.fetched).toHaveLength(0);
  expect(pickedAgy()).toBeUndefined();
});

test("a download that doesn't match Google's checksum is never used, and waits before trying again", async () => {
  let now = 1_000_000;
  const { agy, fetched, logs } = copy({ sha512: "0".repeat(128), bytes: build("6.6.6").bytes, now: () => now });
  await agy.check();
  expect(existsSync(agy.file())).toBe(false);
  expect(pickedAgy()).toBeUndefined();
  expect(logs.some((l) => l.includes("checksum"))).toBe(true);
  await agy.check();
  expect(fetched).toHaveLength(1);
  now += 31 * 60_000;
  await agy.check();
  expect(fetched).toHaveLength(2);
});

test("a Gemini sign-in on a computer with no agy: the copy at once, whoever else uses Gemini there; a failure in words", async () => {
  const { agy, fetched } = copy({ inUse: () => false });
  await agy.ensure();
  expect(fetched).toHaveLength(1);
  expect(pickedAgy()).toBe(agy.file());
  await agy.ensure();
  expect(fetched).toHaveLength(1);
  setAgyPick(undefined);
  const broken = copy({ inUse: () => false, sha512: "0".repeat(128), bytes: build("6.6.6").bytes });
  await expect(broken.agy.ensure()).rejects.toThrow("Couldn't get the Antigravity CLI ready on this computer");
  expect(pickedAgy()).toBeUndefined();
  // The person's own, new enough: nothing to bring.
  const own = copy({ own: async () => ({ file: "/usr/local/bin/agy", version: "agy 9.9.9" }) });
  await own.agy.ensure();
  expect(own.fetched).toHaveLength(0);
});

test("an older copy the runner brought goes once the new one runs", async () => {
  const { agy, home } = copy();
  const old = path.join(home, "bin", "agy-1.0.0");
  mkdirSync(old, { recursive: true });
  writeFileSync(path.join(old, "antigravity"), "old", { mode: 0o755 });
  await agy.check();
  expect(existsSync(old)).toBe(false);
  expect(existsSync(agy.file())).toBe(true);
});

test("the pin: Google's builds for macOS, Linux and Windows, each at a version that runs Gemini 4 Neon", () => {
  expect(Object.keys(AGY_PIN.builds).sort()).toEqual([
    "darwin_amd64",
    "darwin_arm64",
    "linux_amd64",
    "linux_amd64_musl",
    "linux_arm64",
    "linux_arm64_musl",
    "windows_amd64",
    "windows_arm64",
  ]);
  for (const b of Object.values(AGY_PIN.builds) as { url: string; sha512: string; version?: string }[]) {
    const version = b.version ?? AGY_PIN.version;
    expect(b.url.startsWith(`https://storage.googleapis.com/antigravity-public/antigravity-cli/${version}-`)).toBe(
      true,
    );
    expect(b.sha512).toMatch(/^[0-9a-f]{128}$/);
    expect(cliVersionAtLeast(version, ANTIGRAVITY_NEON_CLI)).toBe(true);
  }
  // Google's Windows build is the program itself, no archive.
  expect(AGY_PIN.builds.windows_amd64.url.endsWith("/windows-x64/cli_windows_x64.exe")).toBe(true);
  expect(agyPlatform("darwin", "arm64")).toBe("darwin_arm64");
  expect(agyPlatform("linux", "x64", () => false)).toBe("linux_amd64");
  expect(agyPlatform("linux", "arm64", (f) => f.includes("musl-aarch64"))).toBe("linux_arm64_musl");
  expect(agyPlatform("win32", "x64")).toBe("windows_amd64");
  expect(agyPlatform("win32", "arm64")).toBe("windows_arm64");
});

test("Windows: Google's bare .exe, checked, kept as `antigravity.exe` at its own version, and every `agy` runs it", async () => {
  const bytes = Buffer.from("MZ fake windows program");
  const sha512 = createHash("sha512").update(bytes).digest("hex");
  const url = "https://downloads.example/1.6.0/windows-x64/cli_windows_x64.exe";
  const { agy, fetched } = copy({
    bytes,
    pin: { version: "9.9.9", builds: { windows_amd64: { version: "1.6.0", url, sha512 } } },
    platform: "windows_amd64",
  });
  await agy.ensure();
  expect(fetched).toEqual([url]);
  expect(agy.file().endsWith(path.join("agy-1.6.0", "antigravity.exe"))).toBe(true);
  expect(readFileSync(agy.file())).toEqual(bytes);
  expect(pickedAgy()).toBe(agy.file());
  // A turn's and a sign-in's `agy` on Windows: this file, never one found on the PATH.
  expect(resolveCommand("agy", "C:\\Users\\bia\\AppData\\Local\\agy\\bin", undefined, "win32")).toBe(agy.file());
  expect(cliSpawn(["agy"], ["models"], "", "win32").file).toBe(agy.file());
  // The person's own at that version runs as it is.
  setAgyPick(undefined);
  const own = copy({
    bytes,
    pin: { version: "9.9.9", builds: { windows_amd64: { version: "1.6.0", url, sha512 } } },
    platform: "windows_amd64",
    own: async () => ({ file: "C:\\agy.exe", version: "1.6.0" }),
  });
  await own.agy.ensure();
  expect(own.fetched).toHaveLength(0);
});
