// Live game t8Xue7oYr: the Journalist's claim "im journalist. carlickadon68 got no report, fake cop" went out as
// "im journalist." because chatShorten kept only the first sentence.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatShorten, PUBLIC_MAX } from "../src/index.js";

test("a line under the chat cap keeps every sentence", () => {
  for (const line of ["im journalist. carlickadon68 got no report, fake cop", "im cop. dot guilty", "bea is lying, im the real cop. cal guilty, dot inno"]) {
    assert.equal(chatShorten(line), line);
  }
});

test("a line over the cap keeps its first sentence, else is cut at a word under the cap", () => {
  const long = `im journalist. ${"carlickadon68 got no report and nobody else did either ".repeat(2)}`;
  assert.equal(chatShorten(long), "im journalist.");
  const run = "word ".repeat(40);
  assert.ok(chatShorten(run).length <= PUBLIC_MAX);
  assert.equal(chatShorten("first line\nsecond line"), "first line");
});
