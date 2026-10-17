// Journalist targets and public reports in self-play: only legitimate info, no illegal actions or vegs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runSelfplay } from "../src/selfplay.js";

test("Journalist: Cop claimer first, then pushers/claimers; every public report matches what it really saw", async () => {
  const { results, scorecard } = await runSelfplay({ games: 20, seed: 1 });
  assert.equal(scorecard.illegalActions.total, 0);
  assert.equal(scorecard.vegs, 0);
  const later = results.flatMap((r) => r.stats.journalistChecks.filter((j) => j.day >= 2));
  assert.ok(later.some((j) => j.targetRole !== "Cop"), "visits someone other than a Cop claimer from Night 2");
  assert.ok(later.some((j) => /Mafioso|Janitor|Lawyer/.test(j.targetRole)), "pushers include scum");
  let said = 0;
  for (const r of results) {
    const jName = Object.keys(r.roles).find((n) => r.roles[n] === "Journalist");
    const seen = r.stats.journalistChecks;
    for (const line of r.log) {
      const m = /^Day \d+ (\w+): (.*)$/.exec(line);
      if (!m || m[1] !== jName) continue;
      for (const [, who, what] of m[2].matchAll(/(\w+) (got no report|is janitor)/g)) {
        const name = Object.keys(r.roles).find((n) => n.toLowerCase() === who.toLowerCase());
        const visits = seen.filter((j) => j.target === name);
        said += 1;
        if (what === "is janitor") assert.ok(r.roles[name] === "Janitor" && visits.some((j) => j.sawReport), line);
        else assert.ok(visits.some((j) => !j.sawReport), `${line}: claimed no report without a visit that showed none`);
      }
    }
  }
  assert.ok(said > 0, "the Journalist shares reports in public");
});
