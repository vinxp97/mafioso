// Adaptive mafia in self-play: the --mafia option, natural chat only, no obvious bloc, stable kill votes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { playSelfplayGame, runSelfplay } from "../src/selfplay.js";

const SCUM = new Set(["Mafioso", "Janitor", "Lawyer"]);

test("--mafia reaches every seat's view and the scorecard; adaptive is the self-play default", async () => {
  for (const mafia of ["adaptive", "script"]) {
    const r = await playSelfplayGame({ seed: 3, game: 0, mafia, keepServer: true });
    const views = Object.values(r.server.table.views);
    assert.ok(views.length === 9 && views.every((v) => v.config?.mafia === mafia), mafia);
  }
  assert.equal((await runSelfplay({ games: 1, seed: 3 })).scorecard.mafiaMode, "adaptive");
  assert.equal((await runSelfplay({ games: 1, seed: 3, mafia: "script" })).scorecard.mafiaMode, "script");
});

test("adaptive mafia: natural-language chat only, never all three scum on one lynch short of the endgame, kill votes hold", async () => {
  const { results, scorecard } = await runSelfplay({ games: 12, seed: 2 });
  assert.equal(scorecard.illegalActions.total, 0);
  assert.equal(scorecard.vegs, 0);
  let blocDays = 0;
  for (const r of results) {
    const alive = new Set(Object.keys(r.roles));
    for (const line of r.log) {
      const chat = /^(?:Day|Night) \d+ (?:\[[^\]]+\] )?\w+: (.*)$/.exec(line);
      if (chat && !/ votes: /.test(line)) assert.doesNotMatch(chat[1], /\bPLAN\b|\b\w+=\w+/, line);
      const died = /^(?:Day|Night) \d+ (\w+) \(/.exec(line);
      if (died && / dies: /.test(line)) alive.delete(died[1]);
      const votes = /^Day \d+ votes: (.*)$/.exec(line);
      if (!votes) continue;
      const scumAlive = [...alive].filter((n) => SCUM.has(r.roles[n])).length;
      const endgame = scumAlive >= alive.size - scumAlive - 1;
      for (const part of votes[1].split("; ")) {
        const [target, voters = ""] = part.split(" <- ");
        const scumOn = voters.split(",").filter((n) => SCUM.has(r.roles[n])).length;
        if (scumOn >= 3 && target !== "no one" && !endgame) blocDays += 1;
      }
    }
    assert.deepEqual(r.stats.killVoteMoves, [], `game ${r.game}: a stale kill vote replaced the agreed kill`);
  }
  assert.equal(blocDays, 0);
});
