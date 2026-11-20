import assert from "node:assert/strict";
import test from "node:test";

import {
  HcSubagentsWidget,
  STATUS_KEY,
  WIDGET_KEY,
  formatWidgetLines,
  type WidgetRecordLike,
} from "../../src/ui/widget.ts";

const NOW = Date.parse("2026-11-20T12:10:00.000Z");

function record(overrides: Partial<WidgetRecordLike> = {}): WidgetRecordLike {
  return {
    agent: "reviewer",
    state: "working",
    createdAt: "2026-11-20T12:08:00.000Z",
    model: "anthropic/gpt-6.1-sol",
    cwd: "/repo/packages/api",
    ...overrides,
  };
}

test("no active children renders nothing", () => {
  assert.deepEqual(formatWidgetLines([], { now: NOW }), []);
  assert.deepEqual(formatWidgetLines([record({ state: "completed" })], { now: NOW }), []);
});

test("one child renders agent, state, duration, model, and short cwd", () => {
  const lines = formatWidgetLines([record()], { now: NOW });
  assert.equal(lines.length, 1);
  assert.match(lines[0] ?? "", /^↳ reviewer {2}working {2}2m {2}anthropic\/gpt-6\.1-sol {2}…\/packages\/api$/);
});

test("blocked children show the blocked kind instead of a model", () => {
  const lines = formatWidgetLines(
    [record({ agent: "scout", state: "blocked", createdAt: "2026-11-20T12:09:00.000Z", turns: [{ blocked: { kind: "permission" } }] })],
    { now: NOW },
  );
  assert.match(lines[0] ?? "", /scout {2}blocked {2}1m {2}permission/);
});

test("many children are capped with an overflow marker", () => {
  const records = Array.from({ length: 9 }, (_, index) =>
    record({ agent: `agent-${index}`, createdAt: `2026-11-20T12:0${index}:00.000Z` }),
  );
  const lines = formatWidgetLines(records, { now: NOW, maxLines: 6 });
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1), "+4 more");
  assert.equal(lines.filter((line) => line.startsWith("↳")).length, 5);
});

test("lines are truncated to the terminal width", () => {
  const lines = formatWidgetLines([record({ agent: "a-very-long-agent-name" })], { now: NOW, width: 30 });
  assert.ok((lines[0] ?? "").length <= 30);
  assert.match(lines[0] ?? "", /…$/);
});

test("widget sets and clears footer status and widget lines", () => {
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const ui = {
    setStatus(key: string, text: string | undefined) {
      assert.equal(key, STATUS_KEY);
      statuses.push(text);
    },
    setWidget(key: string, content: string[] | undefined) {
      assert.equal(key, WIDGET_KEY);
      widgets.push(content);
    },
  };
  const widget = new HcSubagentsWidget(ui, { now: () => NOW, debounceMs: 0 });
  widget.refresh([record()]);
  assert.equal(statuses.at(-1), "1 active");
  assert.match(widgets.at(-1)?.[0] ?? "", /reviewer/);

  widget.refresh([record(), record({ agent: "scout" })]);
  assert.equal(statuses.at(-1), "2 active");

  widget.refresh([record({ state: "completed" })]);
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);

  widget.clear();
  assert.equal(statuses.at(-1), undefined);
  assert.equal(widgets.at(-1), undefined);
  widget.dispose();
});

test("widget output never contains task or result text", () => {
  const withText = record({
    // Extra fields are not part of the formatter's input contract and must be ignored.
    task: "SECRET TASK",
    resultText: "SECRET RESULT",
  } as unknown as WidgetRecordLike);
  const lines = formatWidgetLines([withText], { now: NOW });
  assert.equal(lines.some((line) => line.includes("SECRET")), false);
});
