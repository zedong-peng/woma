import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { activatePackage } from "../src/activation.js";
import { doctorPackage } from "../src/doctor.js";
import { installPackageSource } from "../src/package.js";

async function fixture(root: string, version: string): Promise<string> {
  const packageRoot = path.join(root, `package-${version}`);
  await mkdir(path.join(packageRoot, "skills", "workflow"), { recursive: true });
  await writeFile(
    path.join(packageRoot, "harness.yaml"),
    `apiVersion: harness.conda/v1
kind: Harness
metadata:
  name: doctor-version
  version: ${version}
  description: Doctor version fixture.
spec:
  platforms: [codex]
  skills:
    - name: workflow
      path: ./skills/workflow
`,
    "utf8",
  );
  await writeFile(path.join(packageRoot, "skills", "workflow", "SKILL.md"), `---\ndescription: ${version}.\n---\n`, "utf8");
  return packageRoot;
}

test("doctor fails when the active and locked package versions differ", { concurrency: false }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "harness-doctor-"));
  process.env.HARNESS_HOME = path.join(root, "home");
  try {
    const project = path.join(root, "project");
    const versionOne = await installPackageSource(await fixture(root, "1.0.0"));
    const versionTwo = await installPackageSource(await fixture(root, "2.0.0"));
    await activatePackage(versionOne, project, ["codex"]);

    const checks = await doctorPackage(versionTwo, project);
    const activation = checks.find((check) => check.label === "activation");
    assert.equal(activation?.status, "fail");
    assert.match(activation?.detail ?? "", /active doctor-version@1\.0\.0, locked doctor-version@2\.0\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
