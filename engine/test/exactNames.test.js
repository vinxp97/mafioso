import { test } from "node:test";
import assert from "node:assert/strict";
import { exactNames, finalSpeak, humanizeSpeak } from "../src/index.js";

const view = { players: { a: { id: "a", name: "Vinman" }, b: { id: "b", name: "Ash_Quill42" }, c: { id: "c", name: "BeaStone7" }, d: { id: "d", name: "Al" } }, dead: { c: true } };

test("a full name takes the player's exact capitalization (dead players too)", () => {
  assert.equal(exactNames(view, "vinman is sus"), "Vinman is sus");
  assert.equal(exactNames(view, "VINMAN, claim"), "Vinman, claim");
  assert.equal(exactNames(view, "beastone7 flipped town"), "BeaStone7 flipped town");
  assert.equal(exactNames(view, "vinman's vote on bea"), "Vinman's vote on bea");
});

test("names with digits or underscores match as whole words", () => {
  assert.equal(exactNames(view, "ash_quill42 and ASH_QUILL42."), "Ash_Quill42 and Ash_Quill42.");
  assert.equal(exactNames(view, "ash_quill4 or ash_quill421 or ash_quill42_x"), "ash_quill4 or ash_quill421 or ash_quill42_x");
});

test("partial names and nicknames stay as written; no matches inside other words", () => {
  assert.equal(exactNames(view, "vin and bea and Ash are quiet"), "vin and bea and Ash are quiet");
  assert.equal(exactNames(view, "vinmanx and xvinman and also all, al?"), "vinmanx and xvinman and also all, Al?");
  assert.equal(exactNames({ players: { m: { id: "m", name: "Me" } } }, "why me"), "why me");
  assert.equal(exactNames(view, "totally normal"), "totally normal");
});

test("applied on outgoing speak only", () => {
  assert.equal(humanizeSpeak(view, { event: "speak", data: { meetingId: "v", content: "vote vinman" } }).data.content, "vote Vinman");
  assert.equal(finalSpeak(view, { event: "speak", data: { meetingId: "v", content: "vote vinman" } }).data.content, "vote Vinman");
  const vote = { event: "vote", data: { meetingId: "v", selection: "a" } };
  assert.equal(finalSpeak(view, vote), vote);
});
