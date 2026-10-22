// Live game t8Xue7oYr: the Journalist claim must keep the report when under PUBLIC_MAX.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chatShorten, PUBLIC_MAX } from "../src/index.js";

test("a line under the chat cap keeps every sentence", () => {
  for (const line of ["im journalist. carlickadon68 got no report, fake cop", "im cop. dot guilty", "bea is lying, im the real cop. cal guilty, dot inno"]) {
    assert.equal(chatShorten(line), line);
  }
  const l9 = "im journalist. GertaLaurice19 got a cop report, real cop, it said ElonoreSheepshanks60 guilty";
  assert.ok(l9.length > 80 && l9.length <= PUBLIC_MAX);
  assert.equal(chatShorten(l9), l9);
});

test("a line over the cap keeps its first sentence, else is cut at a word under the cap", () => {
  const pad = "carlickadon68 got no report and nobody else did either ";
  const long = "im journalist. " + pad.repeat(6);
  assert.ok(long.length > PUBLIC_MAX, String(long.length));
  assert.equal(chatShorten(long), "im journalist.");
  const run = "word ".repeat(80);
  assert.ok(chatShorten(run).length <= PUBLIC_MAX);
  assert.equal(chatShorten("first line\nsecond line"), "first line");
});
