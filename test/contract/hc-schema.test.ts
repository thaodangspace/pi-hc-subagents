import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { HC_METHODS } from "../../src/core/core-client.ts";
import { HC_MIN_VERSION, compareVersions } from "../../src/core/hc-types.ts";

interface SchemaParam {
  name: string;
  required?: boolean;
  schema?: unknown;
}

interface SchemaMethod {
  name: string;
  params?: SchemaParam[];
}

interface HcSchema {
  info?: { version?: string };
  methods?: SchemaMethod[];
}

const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/hc-schema.json");

let schema: HcSchema;

test("load the pinned hc schema snapshot", async () => {
  schema = JSON.parse(await readFile(fixturePath, "utf8")) as HcSchema;
  assert.ok(Array.isArray(schema.methods) && schema.methods.length > 0);
  assert.ok(typeof schema.info?.version === "string");
  assert.ok(
    compareVersions(schema.info.version, HC_MIN_VERSION) >= 0,
    `pinned schema ${schema.info.version} is older than the supported minimum ${HC_MIN_VERSION}`,
  );
});

test("every method used by CoreClient exists in the pinned schema", () => {
  const names = new Set((schema.methods ?? []).map((method) => method.name));
  for (const method of Object.keys(HC_METHODS)) {
    assert.ok(names.has(method), `hc schema is missing ${method}`);
  }
});

test("every wire parameter used by CoreClient exists in the pinned schema", () => {
  const byName = new Map((schema.methods ?? []).map((method) => [method.name, method]));
  for (const [method, params] of Object.entries(HC_METHODS)) {
    const definition = byName.get(method);
    assert.ok(definition, `missing method ${method}`);
    const known = new Map((definition.params ?? []).map((param) => [param.name, param]));
    for (const param of params) {
      assert.ok(known.has(param), `hc ${method} is missing parameter ${param}`);
    }
  }
});

test("key parameters keep the types the client depends on", () => {
  const byName = new Map((schema.methods ?? []).map((method) => [method.name, method]));
  const param = (method: string, name: string): SchemaParam => {
    const found = byName.get(method)?.params?.find((item) => item.name === name);
    assert.ok(found, `missing ${method}.${name}`);
    return found;
  };

  const terminalRun = byName.get("terminal.run");
  assert.ok(terminalRun?.params?.some((item) => item.name === "argv"));
  assert.ok(param("terminal.run", "no_notify"));

  const getTerminal = param("terminal.get", "terminal");
  assert.equal(getTerminal.required, true);
  const sendText = param("terminal.send", "text");
  assert.equal(sendText.required, true);
  const sendIf = param("terminal.send", "if");
  assert.ok(JSON.stringify(sendIf.schema).includes("IdleOrWorking"));
  const labelLabels = param("terminal.label", "labels");
  assert.equal(labelLabels.required, true);
});
