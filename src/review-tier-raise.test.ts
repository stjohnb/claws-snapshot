import { describe, it, expect } from "vitest";
import { decideReviewRaise, isConfigValueEdit, isDocsPath, isExcludedPath, parseNumstat } from "./review-tier-raise.js";

const decide = (numstat: string | null, threshold = 150, ignorePaths: string[] = []) => decideReviewRaise({ numstat, threshold, ignorePaths });

describe("parseNumstat", () => {
  it("reads counts and paths, with null counts for binary files", () => {
    expect(parseNumstat("3\t1\tsrc/a.ts\n-\t-\timg/logo.png\n\n")).toEqual([
      { path: "src/a.ts", added: 3, deleted: 1 },
      { path: "img/logo.png", added: null, deleted: null },
    ]);
  });
});

describe("path classification", () => {
  it("excludes lockfiles, generated files and vendored trees", () => {
    for (const p of ["package-lock.json", "web/yarn.lock", "flake.lock", "go.sum", "a/b.min.js", "x.js.map", "src/__snapshots__/a.ts.snap", "dist/index.js", "vendor/lib/a.go"]) {
      expect(isExcludedPath(p), p).toBe(true);
    }
    expect(isExcludedPath("src/build.ts")).toBe(false);
  });

  it("treats docs extensions and docs/ paths as docs", () => {
    for (const p of ["README.md", "a/b.mdx", "NOTES.txt", "x.rst", "docs/diagram.svg"]) expect(isDocsPath(p), p).toBe(true);
    expect(isDocsPath("src/docs.ts")).toBe(false);
  });

  it("accepts only balanced, small config edits outside CI trees", () => {
    expect(isConfigValueEdit({ path: "config/app.yaml", added: 2, deleted: 2 })).toBe(true);
    expect(isConfigValueEdit({ path: ".env", added: 1, deleted: 1 })).toBe(true);
    expect(isConfigValueEdit({ path: "config/app.yaml", added: 3, deleted: 2 })).toBe(false);
    expect(isConfigValueEdit({ path: "config/app.yaml", added: 11, deleted: 11 })).toBe(false);
    expect(isConfigValueEdit({ path: ".forgejo/workflows/ci.yml", added: 1, deleted: 1 })).toBe(false);
    expect(isConfigValueEdit({ path: ".github/workflows/ci.yml", added: 1, deleted: 1 })).toBe(false);
    expect(isConfigValueEdit({ path: "src/a.ts", added: 1, deleted: 1 })).toBe(false);
  });
});

describe("decideReviewRaise", () => {
  it("raises on lines over the threshold, even for docs", () => {
    expect(decide("150\t50\tdocs/guide.md")).toEqual({ raise: true, reason: "200 lines changed", kind: "lines", lines: 200 });
  });

  it("keeps a docs change at the threshold", () => {
    expect(decide("100\t50\tdocs/guide.md")).toEqual({ raise: false, lines: 150 });
  });

  it("raises any code change, naming the first file and counting the rest", () => {
    expect(decide("2\t1\tsrc/foo.ts\n1\t0\tsrc/bar.ts\n1\t0\tsrc/baz.test.ts\n1\t1\tREADME.md")).toMatchObject({
      raise: true, kind: "code", reason: "changes code (src/foo.ts and 2 more files)", lines: 7,
    });
    expect(decide("2\t1\tsrc/foo.ts")).toMatchObject({ reason: "changes code (src/foo.ts)" });
  });

  it("keeps a config-value-only edit and raises a config file that gains lines", () => {
    expect(decide("1\t1\tk8s/values.yaml\n4\t2\tdocs/x.md")).toEqual({ raise: false, lines: 8 });
    expect(decide("12\t0\tk8s/ingress.yaml")).toMatchObject({ raise: true, kind: "code" });
  });

  it("raises an equal but over-10-line config edit and any workflow YAML edit", () => {
    expect(decide("11\t11\tconfig/app.json")).toMatchObject({ raise: true, kind: "code" });
    expect(decide("1\t1\t.forgejo/workflows/ci.yml")).toMatchObject({ raise: true, kind: "code" });
  });

  it("drops lockfiles, binaries and ignorePaths from both rules", () => {
    expect(decide("5000\t4000\tpackage-lock.json\n-\t-\tlogo.png\n2\t2\tdocs/a.md")).toEqual({ raise: false, lines: 4 });
    expect(decide("400\t0\tgenerated/schema.ts\n1\t0\tdocs/a.md", 150, ["generated"])).toEqual({ raise: false, lines: 1 });
  });

  it("raises when the diff could not be measured", () => {
    expect(decide(null)).toEqual({ raise: true, reason: "diff could not be measured", kind: "unmeasured", lines: null });
  });

  it("never raises with a threshold of 0", () => {
    expect(decide("500\t0\tsrc/foo.ts", 0)).toEqual({ raise: false, lines: 0 });
    expect(decide(null, 0)).toMatchObject({ raise: false });
  });

  it("strips * and newlines from the reason", () => {
    expect(decide("1\t0\tsrc/*weird*.ts")).toMatchObject({ reason: "changes code (src/ weird .ts)" });
  });
});
