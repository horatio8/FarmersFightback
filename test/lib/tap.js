// The smallest test runner that does what this suite needs.
//
// No dependency, because the site itself has none: adding a framework to run
// the tests would be the largest thing in the repo. Suites are plain async
// functions; a failure is a thrown error.

const RESET = "\x1b[0m", RED = "\x1b[31m", GREEN = "\x1b[32m", DIM = "\x1b[2m", BOLD = "\x1b[1m";

function createRun(label) {
  const results = { label, passed: 0, failed: 0, skipped: 0, failures: [], started: Date.now() };
  let group = "";

  const api = {
    group(name) { group = name; console.log(`\n${BOLD}${name}${RESET}`); },

    async test(name, fn) {
      try {
        await fn();
        results.passed += 1;
        console.log(`  ${GREEN}ok${RESET}  ${name}`);
      } catch (e) {
        results.failed += 1;
        const detail = (e && e.message) || String(e);
        results.failures.push({ group, name, detail, code: e && e.code });
        console.log(`  ${RED}FAIL${RESET} ${name}`);
        console.log(`       ${DIM}${detail.split("\n").join("\n       ")}${RESET}`);
      }
    },

    skip(name, why) {
      results.skipped += 1;
      console.log(`  ${DIM}skip${RESET} ${name} ${DIM}(${why})${RESET}`);
    },

    results,
  };
  return api;
}

// Assertions that say what actually went wrong. Every message is written to be
// readable by someone who did not write the test.
const assert = {
  ok(v, msg) { if (!v) throw new Error(msg || "expected a truthy value"); },
  equal(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error(`${msg || "not equal"}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
    }
  },
  // Structural comparison via JSON, which is what the values under test are:
  // Airtable field payloads. Key order matters, so compare shapes you build.
  deepEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      throw new Error(`${msg || "not equal"}\n  expected: ${b}\n  actual:   ${a}`);
    }
  },
  notEqual(actual, unexpected, msg) {
    if (actual === unexpected) throw new Error(`${msg || "should not equal"} ${JSON.stringify(unexpected)}`);
  },
  match(value, re, msg) {
    if (!re.test(String(value))) {
      throw new Error(`${msg || "no match"}\n  pattern: ${re}\n  value:   ${String(value).slice(0, 300)}`);
    }
  },
  noMatch(value, re, msg) {
    if (re.test(String(value))) {
      throw new Error(`${msg || "unexpected match"}\n  pattern: ${re}\n  value:   ${String(value).slice(0, 300)}`);
    }
  },
  includes(haystack, needle, msg) {
    if (!String(haystack).includes(needle)) {
      throw new Error(`${msg || "missing"}: ${JSON.stringify(needle)}`);
    }
  },
  excludes(haystack, needle, msg) {
    if (String(haystack).includes(needle)) {
      throw new Error(`${msg || "should be absent"}: ${JSON.stringify(needle)}`);
    }
  },
  empty(list, msg) {
    const arr = Array.from(list || []);
    if (arr.length) {
      const shown = arr.slice(0, 6).map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
      throw new Error(`${msg || "expected nothing"}, got ${arr.length}:\n  - ${shown.join("\n  - ")}`);
    }
  },
  async throws(fn, msg) {
    try { await fn(); } catch { return; }
    throw new Error(msg || "expected this to throw");
  },
};

function summarise(runs) {
  const total = runs.reduce((a, r) => ({
    passed: a.passed + r.passed,
    failed: a.failed + r.failed,
    skipped: a.skipped + r.skipped,
  }), { passed: 0, failed: 0, skipped: 0 });
  const all = runs.flatMap((r) => r.failures.map((f) => ({ ...f, suite: r.label })));
  return { ...total, failures: all };
}

module.exports = { createRun, assert, summarise, colours: { RESET, RED, GREEN, DIM, BOLD } };
