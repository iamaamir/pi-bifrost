// Capability-owned mutation enrollment (issue #274 stage 4).
//
// These tests exercise real filesystem discovery in isolated fixture roots. The
// production inventory is composed from the repository descriptors; these
// fixtures pin the contract that a descriptor is data-only, capability-relative,
// validated, and deterministic.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CAPABILITY_DESCRIPTOR, assertEnrollmentCurrent, discoverCapabilityTargets } from "../mutation/enrollment.mjs";
import { assertUniqueReportStems } from "../mutation/targets.mjs";

const SOURCE = "export const value = 1;\n";

function record(overrides = {}) {
  return {
    file: "alpha.ts",
    mutants: 12,
    secondsPerMutant: 0.5,
    timeoutFactor: 2,
    timeoutMS: 20_000,
    ...overrides,
  };
}

function descriptor(targets = [record()]) {
  return { targets };
}

/**
 * Build a fixture root. `capabilities` maps a capability name to either a
 * descriptor object, a raw descriptor string, or null for "no descriptor".
 * `sources` maps repository-relative files to contents.
 */
function fixture(capabilities = {}, sources = {}) {
  const root = mkdtempSync(join(tmpdir(), "mutation-enrollment-"));
  mkdirSync(join(root, "modules"), { recursive: true });
  for (const [capability, value] of Object.entries(capabilities)) {
    const directory = join(root, "modules", capability);
    mkdirSync(directory, { recursive: true });
    if (value === null) continue;
    writeFileSync(
      join(directory, CAPABILITY_DESCRIPTOR),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  for (const [path, content] of Object.entries(sources)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return root;
}

function withFixture(options, callback) {
  const root = fixture(options.capabilities, options.sources);
  try {
    return callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function alpha(extra = {}) {
  return {
    capabilities: { alpha: descriptor([record()]) },
    sources: { "modules/alpha/alpha.ts": SOURCE },
    ...extra,
  };
}

test("a capability without a descriptor is not enrolled", () => {
  withFixture({ capabilities: { alpha: null }, sources: { "modules/alpha/alpha.ts": SOURCE } }, (root) => {
    const result = discoverCapabilityTargets({ root });
    assert.deepEqual(result.names, []);
    assert.deepEqual(result.targets, {});
    assert.deepEqual(result.estimates, {});
    assert.deepEqual(result.overrides, {});
  });
});

test("a valid descriptor enrolls one capability-relative source file", () => {
  withFixture(alpha(), (root) => {
    const result = discoverCapabilityTargets({ root });
    assert.deepEqual(result.names, ["modules/alpha/alpha.ts"]);
    assert.deepEqual(result.targets, {
      "modules/alpha/alpha.ts": { timeoutFactor: 2, timeoutMS: 20_000, secondsPerMutant: 0.5 },
    });
    assert.deepEqual(result.estimates, { "modules/alpha/alpha.ts": 12 });
    assert.deepEqual(result.overrides, {});
    assert.equal(result.records[0].capability, "alpha");
    assert.equal(result.records[0].descriptor, "modules/alpha/mutation.json");
    assert.equal(result.records[0].file, "alpha.ts");
  });
});

test("a supported runner override and its reason are preserved", () => {
  withFixture(
    {
      capabilities: {
        alpha: descriptor([record({ file: "alpha.ts", runner: "tap", reason: "production engine only" })]),
      },
      sources: { "modules/alpha/alpha.ts": SOURCE },
    },
    (root) => {
      const result = discoverCapabilityTargets({ root });
      assert.deepEqual(result.overrides, {
        "modules/alpha/alpha.ts": { runner: "tap", reason: "production engine only" },
      });
      assert.deepEqual(result.targets["modules/alpha/alpha.ts"], {
        timeoutFactor: 2,
        timeoutMS: 20_000,
        secondsPerMutant: 0.5,
      });
    },
  );
});

test("discovery order is a stable code-unit comparison, independent of directory order", () => {
  withFixture(
    {
      capabilities: {
        zulu: descriptor([record({ file: "zulu.ts" })]),
        alpha: descriptor([record({ file: "alpha.ts" })]),
        mike: descriptor([record({ file: "mike.ts" })]),
      },
      sources: {
        "modules/zulu/zulu.ts": SOURCE,
        "modules/alpha/alpha.ts": SOURCE,
        "modules/mike/mike.ts": SOURCE,
      },
    },
    (root) => {
      const result = discoverCapabilityTargets({ root });
      assert.deepEqual(result.names, [
        "modules/alpha/alpha.ts",
        "modules/mike/mike.ts",
        "modules/zulu/zulu.ts",
      ]);
    },
  );
});

test("a descriptor outside the reserved direct capability location is ignored", () => {
  withFixture(
    {
      capabilities: { alpha: null },
      sources: {
        "modules/alpha/sub/mutation.json": JSON.stringify(descriptor([record({ file: "x.ts" })])),
        "modules/alpha/sub/x.ts": SOURCE,
      },
    },
    (root) => {
      assert.deepEqual(discoverCapabilityTargets({ root }).names, []);
    },
  );
});

test("malformed, empty and unknown-shape descriptors fail closed", () => {
  const cases = [
    ["malformed JSON", "not json", /malformed|JSON/iu],
    ["empty descriptor", { targets: [] }, /empty|at least one/iu],
    ["missing targets", {}, /targets/iu],
    ["unknown top-level field", { targets: [record()], extra: true }, /unknown field/iu],
    ["unknown record field", descriptor([record({ note: "later" })]), /unknown field/iu],
    ["missing required field", descriptor([{ file: "alpha.ts" }]), /mutants|secondsPerMutant|timeout/iu],
    ["descriptor is a directory", null, /regular file|unreadable/iu],
  ];
  for (const [name, value, expected] of cases) {
    withFixture(
      {
        capabilities: { alpha: value === null ? null : value },
        sources: { "modules/alpha/alpha.ts": SOURCE },
      },
      (root) => {
        if (value === null) mkdirSync(join(root, "modules", "alpha", CAPABILITY_DESCRIPTOR), { recursive: true });
        assert.throws(() => discoverCapabilityTargets({ root }), expected, name);
      },
    );
  }
});

test("measured inputs must be finite and positive", () => {
  const cases = [
    ["zero mutants", { mutants: 0 }, /mutants.*positive integer/iu],
    ["negative mutants", { mutants: -1 }, /mutants.*positive integer/iu],
    ["fractional mutants", { mutants: 1.5 }, /mutants.*positive integer/iu],
    ["non-numeric mutants", { mutants: "12" }, /mutants.*positive integer/iu],
    ["zero seconds", { secondsPerMutant: 0 }, /secondsPerMutant.*positive/iu],
    ["infinite seconds", { secondsPerMutant: Infinity }, /secondsPerMutant.*finite/iu],
    ["zero timeout factor", { timeoutFactor: 0 }, /timeoutFactor.*positive/iu],
    ["zero timeout ms", { timeoutMS: 0 }, /timeoutMS.*positive integer/iu],
    ["fractional timeout ms", { timeoutMS: 1.5 }, /timeoutMS.*positive integer/iu],
  ];
  for (const [name, overrides, expected] of cases) {
    withFixture(
      {
        capabilities: { alpha: descriptor([record(overrides)]) },
        sources: { "modules/alpha/alpha.ts": SOURCE },
      },
      (root) => assert.throws(() => discoverCapabilityTargets({ root }), expected, name),
    );
  }
});

test("runner overrides need a supported runner and a reason", () => {
  const cases = [
    ["unsupported runner", { runner: "jest" }, /unsupported runner/iu],
    ["missing reason", { runner: "tap" }, /reason/iu],
    ["blank reason", { runner: "tap", reason: "   " }, /reason/iu],
    ["reason without runner", { reason: "because" }, /reason.*runner|runner.*reason/iu],
  ];
  for (const [name, overrides, expected] of cases) {
    withFixture(
      {
        capabilities: { alpha: descriptor([record(overrides)]) },
        sources: { "modules/alpha/alpha.ts": SOURCE },
      },
      (root) => assert.throws(() => discoverCapabilityTargets({ root }), expected, name),
    );
  }
});

test("unsafe, noncanonical and non-runtime paths are refused", () => {
  const cases = [
    ["absolute", "/tmp/x.ts", /absolute/iu],
    ["traversal", "../outside.ts", /traversal|segment/iu],
    ["nested traversal", "a/../../outside.ts", /traversal|segment/iu],
    ["glob", "*.ts", /glob/iu],
    ["dot segment", "./alpha.ts", /noncanonical|segment/iu],
    ["empty segment", "a//alpha.ts", /noncanonical|segment/iu],
    ["backslash", "a\\alpha.ts", /noncanonical|backslash/iu],
    ["trailing slash", "alpha.ts/", /noncanonical|segment/iu],
    ["non-runtime extension", "alpha.json", /runtime|\.ts/iu],
    ["test directory", "tests/alpha.ts", /non-runtime|tests/iu],
    ["dependency directory", "node_modules/alpha.ts", /non-runtime|node_modules/iu],
  ];
  for (const [name, file, expected] of cases) {
    withFixture(
      {
        capabilities: { alpha: descriptor([record({ file })]) },
        sources: { "modules/alpha/alpha.ts": SOURCE },
      },
      (root) => assert.throws(() => discoverCapabilityTargets({ root }), expected, name),
    );
  }
});

test("duplicate targets and flattened report-stem collisions are refused", () => {
  withFixture(
    {
      capabilities: { alpha: descriptor([record(), record()]) },
      sources: { "modules/alpha/alpha.ts": SOURCE },
    },
    (root) => assert.throws(() => discoverCapabilityTargets({ root }), /duplicate/iu),
  );

  withFixture(
    {
      capabilities: {
        alpha: descriptor([
          record({ file: "x/y.ts" }),
          record({ file: "x__y.ts" }),
        ]),
      },
      sources: {
        "modules/alpha/x/y.ts": SOURCE,
        "modules/alpha/x__y.ts": SOURCE,
      },
    },
    (root) => assert.throws(() => discoverCapabilityTargets({ root }), /report stem|collision/iu),
  );

  assert.throws(
    () => assertUniqueReportStems(["modules/alpha/x/y.ts", "modules/alpha/x__y.ts"]),
    /report stem|collision/iu,
  );
});

test("a missing source file is refused", () => {
  withFixture(
    {
      capabilities: { alpha: descriptor([record({ file: "missing.ts" })]) },
      sources: {},
    },
    (root) => assert.throws(() => discoverCapabilityTargets({ root }), /missing source|does not exist/iu),
  );
});

test("symlinked descriptors, capabilities, sources and intermediate components are refused", () => {
  withFixture(alpha(), (root) => {
    const descriptorPath = join(root, "modules", "alpha", CAPABILITY_DESCRIPTOR);
    const aside = join(root, "descriptor-aside.json");
    writeFileSync(aside, JSON.stringify(descriptor()));
    rmSync(descriptorPath);
    symlinkSync(aside, descriptorPath);
    assert.throws(() => discoverCapabilityTargets({ root }), /symlink/iu, "descriptor");
  });

  const capabilityRoot = mkdtempSync(join(tmpdir(), "mutation-capability-outside-"));
  try {
    const root = fixture({ capabilities: {}, sources: {} });
    try {
      mkdirSync(join(capabilityRoot, "alpha"), { recursive: true });
      writeFileSync(join(capabilityRoot, "alpha", CAPABILITY_DESCRIPTOR), JSON.stringify(descriptor()));
      writeFileSync(join(capabilityRoot, "alpha", "alpha.ts"), SOURCE);
      symlinkSync(join(capabilityRoot, "alpha"), join(root, "modules", "alpha"));
      assert.throws(() => discoverCapabilityTargets({ root }), /symlink/iu, "capability");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  } finally {
    rmSync(capabilityRoot, { recursive: true, force: true });
  }

  withFixture(alpha(), (root) => {
    const sourcePath = join(root, "modules", "alpha", "alpha.ts");
    const aside = join(root, "source-aside.ts");
    writeFileSync(aside, SOURCE);
    rmSync(sourcePath);
    symlinkSync(aside, sourcePath);
    assert.throws(() => discoverCapabilityTargets({ root }), /symlink/iu, "source");
  });

  const outside = mkdtempSync(join(tmpdir(), "mutation-source-outside-"));
  try {
    withFixture(
      {
        capabilities: { alpha: descriptor([record({ file: "sub/alpha.ts" })]) },
        sources: {},
      },
      (root) => {
        mkdirSync(join(outside, "sub"), { recursive: true });
        writeFileSync(join(outside, "sub", "alpha.ts"), SOURCE);
        symlinkSync(join(outside, "sub"), join(root, "modules", "alpha", "sub"));
        assert.throws(() => discoverCapabilityTargets({ root }), /symlink/iu, "intermediate");
      },
    );
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("a descriptor edited after enrollment fails the current-enrollment check", () => {
  withFixture(alpha(), (root) => {
    const enrolled = discoverCapabilityTargets({ root });
    const snapshot = enrolled.records[0];
    const target = "modules/alpha/alpha.ts";
    const descriptorPath = join(root, "modules", "alpha", CAPABILITY_DESCRIPTOR);
    assert.equal(assertEnrollmentCurrent(target, { root, snapshot }).secondsPerMutant, 0.5);

    // A value edit changes the on-disk descriptor but not the budget the run
    // used. Stamping that report would claim metadata it never measured against.
    writeFileSync(descriptorPath, JSON.stringify(descriptor([record({ secondsPerMutant: 0.75 })])));
    assert.throws(
      () => assertEnrollmentCurrent(target, { root, snapshot }),
      /changed during the run/iu,
    );
  });
});

test("adding or removing a target in an enrolled descriptor fails the snapshot check", () => {
  withFixture(alpha(), (root) => {
    const snapshot = discoverCapabilityTargets({ root }).records[0];
    const target = "modules/alpha/alpha.ts";
    const descriptorPath = join(root, "modules", "alpha", CAPABILITY_DESCRIPTOR);
    writeFileSync(
      descriptorPath,
      JSON.stringify(descriptor([record(), record({ file: "beta.ts" })])),
    );
    writeFileSync(join(root, "modules", "alpha", "beta.ts"), SOURCE);
    assert.throws(
      () => assertEnrollmentCurrent(target, { root, snapshot }),
      /changed during the run/iu,
    );

    rmSync(descriptorPath);
    assert.throws(
      () => assertEnrollmentCurrent(target, { root, snapshot }),
      /no longer enrolled/iu,
    );
    // A central target has no descriptor and needs no walk.
    assert.equal(assertEnrollmentCurrent("cache.ts", { root }), null);
  });
});

test("a nested runtime source is enrollable but tests and declarations are not", () => {
  withFixture(
    {
      capabilities: { alpha: descriptor([record({ file: "sub/helper.ts" })]) },
      sources: { "modules/alpha/sub/helper.ts": SOURCE },
    },
    (root) => {
      assert.deepEqual(discoverCapabilityTargets({ root }).names, ["modules/alpha/sub/helper.ts"]);
    },
  );
  const rejected = [
    ["declaration", "types.d.ts", /runtime|\.d\.ts/iu],
    ["unit test name", "helper.test.ts", /runtime|test/iu],
    ["spec name", "helper.spec.ts", /runtime|spec/iu],
    ["nested tests dir", "sub/tests/helper.ts", /runtime|test/iu],
    ["underscore tests dir", "__tests__/helper.ts", /runtime|test/iu],
    ["test dir", "test/helper.ts", /runtime|test/iu],
    ["comma in path", "a,b.ts", /comma|workflow/iu],
    ["newline in path", "a\nb.ts", /line break|workflow/iu],
  ];
  for (const [name, file, expected] of rejected) {
    withFixture(
      {
        capabilities: { alpha: descriptor([record({ file })]) },
        // The source must exist, otherwise a missing-source error would satisfy
        // the expected regex without exercising the runtime/comma guard.
        sources: { [`modules/alpha/${file}`]: SOURCE },
      },
      (root) => assert.throws(() => discoverCapabilityTargets({ root }), expected, name),
    );
  }
});

test("a symlinked modules root is refused", () => {
  const outside = mkdtempSync(join(tmpdir(), "mutation-modules-outside-"));
  const root = mkdtempSync(join(tmpdir(), "mutation-modules-root-"));
  try {
    mkdirSync(join(outside, "alpha"), { recursive: true });
    writeFileSync(join(outside, "alpha", CAPABILITY_DESCRIPTOR), JSON.stringify(descriptor()));
    writeFileSync(join(outside, "alpha", "alpha.ts"), SOURCE);
    symlinkSync(outside, join(root, "modules"));
    assert.throws(() => discoverCapabilityTargets({ root }), /symlink/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
