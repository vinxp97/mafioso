import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertProcessContainerEnv,
  envFileForContainer,
  hasModelCredential,
  processContainerEnvNames,
} from "../src/containerEnv.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repo, "scripts/mac-container-run.sh");

test("process environment accepts a model key and does not require a file", () => {
  assert.equal(hasModelCredential({ MAFIOSO_LLM: "lmstudio" }), true);
  assert.throws(() => assertProcessContainerEnv({ MAFIOSO_LLM: "openrouter" }), /OPENROUTER_API_KEY empty/);
  assertProcessContainerEnv({ MAFIOSO_LLM: "openrouter", OPENROUTER_API_KEY: "sk-test" });
  const names = processContainerEnvNames({
    MAFIOSO_LLM: "openrouter",
    OPENROUTER_API_KEY: "sk-test",
    DEV_API_BASE_URL: "http://192.168.64.1:3000",
    MAFIOSO_TRACE_MOUNT: "/tmp/traces",
    MAFIOSO_TRACE_DIR: "/Users/ada/mafioso-mac/logs",
    UNRELATED_SECRET: "do-not-forward",
  });
  assert.ok(names.includes("OPENROUTER_API_KEY"));
  assert.ok(names.includes("DEV_API_BASE_URL"));
  assert.equal(names.includes("MAFIOSO_TRACE_DIR"), false);
  assert.equal(names.includes("UNRELATED_SECRET"), false);
  assert.equal(names.includes("MAFIOSO_TRACE_MOUNT"), false);
});

test("the .env file path still rewrites the gateway and still requires the OpenRouter key", () => {
  assert.throws(() => envFileForContainer("MAFIOSO_LIVE=1\n", "192.168.64.1"), /OPENROUTER_API_KEY empty/);
  const parsed = envFileForContainer(
    "OPENROUTER_API_KEY=sk-file\nDEV_API_BASE_URL=https://dev.ultimafia.gg\nOPENROUTER_MODEL=demo\n",
    "192.168.64.1",
  );
  assert.equal(parsed.OPENROUTER_API_KEY, "sk-file");
  assert.equal(parsed.DEV_API_BASE_URL, "http://192.168.64.1:3000");
  assert.equal(parsed.OPENROUTER_MODEL, "demo");
});

function fakeContainer(dir) {
  const bin = path.join(dir, "container");
  const argsFile = path.join(dir, "args");
  const envCopy = path.join(dir, "env-copy");
  fs.writeFileSync(bin, `#!/bin/sh
printf '%s\\n' "$@" >> "${argsFile}"
printf '\\n---\\n' >> "${argsFile}"
prev=""
for arg in "$@"; do
  if [ "$prev" = "--env-file" ]; then
    cp "$arg" "${envCopy}"
  fi
  prev="$arg"
done
exit 0
`);
  fs.chmodSync(bin, 0o755);
  return { bin, argsFile, envCopy };
}

test("process mode does not put the key on argv or in a temp env file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mafioso-ctr-"));
  const { bin, argsFile, envCopy } = fakeContainer(dir);
  const result = spawnSync("bash", [script], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MAFIOSO_ENV_FROM_PROCESS: "1",
      MAFIOSO_CONTAINER_SKIP_BUILD: "1",
      CONTAINER_BIN: bin,
      MAFIOSO_LLM: "openrouter",
      OPENROUTER_API_KEY: "sk-or-supersecretkey",
      OPENROUTER_MODEL: "demo-model",
      MAFIOSO_HOST_GATEWAY: "192.168.64.1",
      MAFIOSO_TRACE_MOUNT: path.join(dir, "traces"),
      MAFIOSO_TRACE_DIR: "/Users/ada/secret-logs",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(argsFile, "utf8");
  assert.doesNotMatch(args, /sk-or-supersecretkey/);
  assert.doesNotMatch(args, /secret-logs/);
  assert.match(args, /-e\nOPENROUTER_API_KEY\n/);
  assert.match(args, /target=\/app\/logs\/traces/);
  assert.equal(fs.existsSync(envCopy), false);
  assert.doesNotMatch(result.stdout + result.stderr, /sk-or-supersecretkey/);
  assert.match(result.stdout, /base=http:\/\/192\.168\.64\.1:3000/);

  const custom = spawnSync("bash", [script], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MAFIOSO_ENV_FROM_PROCESS: "1",
      MAFIOSO_CONTAINER_SKIP_BUILD: "1",
      CONTAINER_BIN: bin,
      MAFIOSO_LLM: "lmstudio",
      MAFIOSO_HOST_GATEWAY: "192.168.64.1",
      DEV_API_BASE_URL: "http://127.0.0.1:3000",
      MAFIOSO_TRACE_MOUNT: path.join(dir, "traces"),
    },
    encoding: "utf8",
  });
  assert.equal(custom.status, 0, custom.stderr);
  assert.match(custom.stdout, /base=http:\/\/127\.0\.0\.1:3000/);
  assert.doesNotMatch(custom.stdout + custom.stderr, /sk-or-supersecretkey/);
});

test("the .env path still runs and keeps the key out of argv", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mafioso-env-"));
  const envFile = path.join(dir, "local.env");
  fs.writeFileSync(envFile, "OPENROUTER_API_KEY=sk-or-filekey\nOPENROUTER_MODEL=from-file\nMAFIOSO_LIVE=1\n");
  const { bin, argsFile, envCopy } = fakeContainer(dir);
  const result = spawnSync("bash", [script], {
    cwd: repo,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      MAFIOSO_ENV_FILE: envFile,
      MAFIOSO_CONTAINER_SKIP_BUILD: "1",
      CONTAINER_BIN: bin,
      MAFIOSO_HOST_GATEWAY: "192.168.64.1",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = fs.readFileSync(argsFile, "utf8");
  assert.doesNotMatch(args, /sk-or-filekey/);
  assert.match(args, /--env-file/);
  const copied = fs.readFileSync(envCopy, "utf8");
  assert.match(copied, /OPENROUTER_API_KEY=sk-or-filekey/);
  assert.match(copied, /DEV_API_BASE_URL=http:\/\/192\.168\.64\.1:3000/);
});
