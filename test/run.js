// The whole suite, in the order that makes each stage cheap.
//
//   node test/run.js            check everything, change nothing
//   node test/run.js --fix      repair what can be repaired, then re-check
//   node test/run.js --update   accept the current rendering as the baseline
//   node test/run.js --unit     unit tests only (no browser, ~1s)
//
// Order matters. Unit tests run first because they are fast and a broken
// helper makes every later result meaningless. The static autofix pass runs
// second: it costs one read and one write per file, and repairing a stale
// cache-bust before the browser stage means the browser stage measures the
// page that will actually ship. The browser regression runs last because it is
// the only expensive part.
//
// Nothing here touches production. Pages are served from the working tree, our
// own API is answered from fixtures, and third-party requests are fulfilled
// locally, so a full run costs no traffic, no Airtable or Campaign Nucleus
// quota, and no API tokens.

const { summarise, colours } = require("./lib/tap");
const { RESET, RED, GREEN, DIM, BOLD } = colours;

const FIX = process.argv.includes("--fix");
const UPDATE = process.argv.includes("--update");
const UNIT_ONLY = process.argv.includes("--unit");

async function main() {
  const runs = [];
  const notes = [];

  console.log(`${BOLD}unit${RESET} ${DIM}— helpers, validation and token rules${RESET}`);
  runs.push(await require("./unit").run());

  if (UNIT_ONLY) return finish(runs, notes);

  // Static pass. Everything it reports is something it can also repair, so in
  // --fix mode a finding is a change rather than a failure.
  console.log(`\n${BOLD}autofix${RESET} ${DIM}— defects that repair themselves${RESET}`);
  const repair = require("./autofix").autofix({ fix: FIX });
  if (repair.fixed.length) notes.push(`${repair.fixed.length} defect(s) repaired automatically`);
  if (!repair.clean) {
    // Reported but not repaired: either --fix was not given, or a rule failed
    // to fix its own finding. Both need to fail the build.
    runs.push({
      label: "autofix",
      passed: 0,
      failed: repair.remaining.length,
      skipped: 0,
      failures: repair.remaining.map((f) => ({
        group: f.rule,
        name: f.file,
        detail: FIX ? `${f.detail} — the rule did not repair it` : `${f.detail} (run with --fix)`,
      })),
    });
  }

  console.log(`\n${BOLD}regression${RESET} ${DIM}— every page rendered in a real browser${RESET}`);
  runs.push(await require("./regression").run({ update: UPDATE }));

  return finish(runs, notes);
}

function finish(runs, notes) {
  const total = summarise(runs);
  console.log("");
  for (const n of notes) console.log(`${DIM}${n}${RESET}`);

  if (total.failures.length) {
    console.log(`${BOLD}${RED}${total.failures.length} failure(s)${RESET}`);
    for (const f of total.failures) {
      console.log(`  ${RED}✗${RESET} ${DIM}[${f.suite}]${RESET} ${f.group} — ${f.name}`);
      console.log(`      ${DIM}${String(f.detail).split("\n")[0]}${RESET}`);
    }
  }

  const colour = total.failed ? RED : GREEN;
  console.log(
    `\n${colour}${BOLD}${total.passed} passed, ${total.failed} failed, ${total.skipped} skipped${RESET}`
  );
  return total.failed ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(`${RED}the suite itself failed to run${RESET}\n${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
