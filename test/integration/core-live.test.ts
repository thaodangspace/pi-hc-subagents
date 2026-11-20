import assert from "node:assert/strict";
import test from "node:test";

import { CoreClient } from "../../src/core/core-client.ts";
import { HC_MIN_VERSION, compareVersions } from "../../src/core/hc-types.ts";
import { hcAvailable, startIsolatedHc } from "./harness.ts";

const available = await hcAvailable();

test("isolated core reports a supported version over the hc socket", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const status = await isolated.core.serverStatus();
    assert.equal(typeof status.version, "string");
    assert.ok(
      compareVersions(status.version, HC_MIN_VERSION) >= 0,
      `core ${status.version} is older than ${HC_MIN_VERSION}`,
    );
    assert.ok(status.pid > 0);
  } finally {
    await isolated.cleanup();
  }
});

test("terminal.run/get/list/label/read/kill/rm round trip", { skip: !available }, async () => {
  const isolated = await startIsolatedHc();
  try {
    const terminal = await isolated.core.run({
      argv: ["sh", "-c", "printf 'hello-from-child\\n'; sleep 60"],
      name: "it-roundtrip",
      labels: { "pi-hc-test": "1" },
      noNotify: true,
      parent: isolated.parentTerminal?.address ?? null,
      wait: false,
      rm: false,
    });
    assert.equal(terminal.name, "it-roundtrip");
    assert.equal(terminal.parent, isolated.parentTerminal?.address);

    const fetched = await isolated.core.get(terminal.address);
    assert.equal(fetched.address, terminal.address);
    assert.equal(fetched.labels["pi-hc-test"], "1");

    const listed = await isolated.core.list({ labels: { "pi-hc-test": "1" } });
    assert.ok(listed.terminals.some((item) => item.address === terminal.address));

    await isolated.core.label(terminal.address, { "pi-hc-session": "/tmp/session.jsonl" });
    const relabeled = await isolated.core.get(terminal.address);
    assert.equal(relabeled.labels["pi-hc-session"], "/tmp/session.jsonl");

    const read = await isolated.core.read(terminal.address, 20);
    assert.match(read.text, /hello-from-child/);

    await isolated.core.kill(terminal.address);
    const finished = await isolated.core.get(terminal.address);
    assert.equal(finished.state, "finished");
    await isolated.core.remove(terminal.address);
    assert.equal(await isolated.core.tryGet(terminal.address), null);
  } finally {
    await isolated.cleanup();
  }
});

test("a client outside a terminal without a socket is unavailable", () => {
  const client = new CoreClient({ socketPath: null });
  assert.equal(client.available, false);
});
