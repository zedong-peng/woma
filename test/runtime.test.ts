import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { create as tar } from "tar";
import { npmRuntimeProvider, runtimePlatform } from "../src/runtime.js";
import { fixture } from "./helpers.js";

test("official provider verifies archives and reuses a resolved immutable release", async (t) => {
  const f = await fixture(t);
  const platform = runtimePlatform().replace(/-musl$/, "");
  const version = "0.154.0";
  const artifactVersion = `${version}-${platform}`;
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
  const tree = path.join(f.root, "archive");
  await mkdir(path.join(tree, "package/vendor", triple, "bin"), { recursive: true });
  await writeFile(path.join(tree, "package/vendor", triple, "bin/codex"), "#!/bin/sh\necho codex-test\n", { mode: 0o755 });
  await writeFile(path.join(tree, "package/package.json"), JSON.stringify({ name: "@openai/codex", version: artifactVersion }));
  const file = path.join(f.root, "runtime.tgz"); await tar({ file, cwd: tree, gzip: true }, ["package"]);
  const bytes = await readFile(file);
  const url = `https://registry.npmjs.org/@openai/codex/-/codex-${artifactVersion}.tgz`;
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  let downloads = 0;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const requested = String(input);
    if (requested === url) { downloads++; return new Response(bytes); }
    const artifact = requested.endsWith(`/${artifactVersion}`);
    return Response.json({ name: "@openai/codex", version: artifact ? artifactVersion : version,
      dist: { tarball: url, integrity },
      ...(artifact ? {} : { optionalDependencies: { [`@openai/codex-${platform}`]: `npm:@openai/codex@${artifactVersion}` } }),
    });
  });
  const first = await npmRuntimeProvider.resolve("codex", "latest");
  const second = await npmRuntimeProvider.resolve("codex", version);
  assert.equal(downloads, 1);
  assert.deepEqual(second.record, first.record);
  const changed = structuredClone(first.record); changed.version = "0.155.0";
  await assert.rejects(npmRuntimeProvider.restore(changed), /artifact identity/);
  const missing = structuredClone(first.record);
  if (missing.source.type === "runtime") missing.source.executable = "platform/missing";
  await assert.rejects(npmRuntimeProvider.restore(missing), /executable is missing/);
});

test("runtime download digest mismatch fails before publishing content", async (t) => {
  const f = await fixture(t);
  const url = "https://registry.npmjs.org/@openai/codex/-/codex-0.154.0.tgz";
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => String(input) === url
    ? new Response("changed archive")
    : Response.json({ name: "@openai/codex", version: "0.154.0", dist: { tarball: url, integrity: `sha512-${Buffer.alloc(64).toString("base64")}` } }));
  await assert.rejects(npmRuntimeProvider.resolve("codex", "0.154.0"), /Runtime download integrity mismatch/);
  await assert.rejects(readFile(path.join(f.root, "state/runtimes/v2", runtimePlatform(), "codex/0.154.0.json")), { code: "ENOENT" });
});
