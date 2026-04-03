import { describe, expect, it } from "vitest";

import {
  formatCount,
  formatTimestamp,
  formatTimestampRange,
  slugifyBranchPreview,
  titleCase
} from "./format";

describe("formatTimestamp", () => {
  it("formats a valid ISO timestamp into HH:MM:SS", () => {
    const result = formatTimestamp("2025-06-01T14:30:45.000Z");
    expect(result).toMatch(/\d{2}:\d{2}:\d{2}/);
  });

  it("returns empty string for invalid input", () => {
    expect(formatTimestamp("not-a-date")).toBe("");
  });
});

describe("formatTimestampRange", () => {
  it("shows both timestamps when they differ", () => {
    const result = formatTimestampRange(
      "2025-06-01T14:30:00.000Z",
      "2025-06-01T14:35:00.000Z"
    );
    expect(result).toContain(" - ");
  });

  it("returns a single timestamp when start and end are equal", () => {
    const ts = "2025-06-01T14:30:00.000Z";
    const result = formatTimestampRange(ts, ts);
    expect(result).not.toContain(" - ");
  });
});

describe("slugifyBranchPreview", () => {
  it("lowercases and replaces non-alphanumeric chars with hyphens", () => {
    expect(slugifyBranchPreview("Fix Login Bug")).toBe("fix-login-bug");
  });

  it("trims leading and trailing hyphens", () => {
    expect(slugifyBranchPreview("--hello--")).toBe("hello");
  });

  it("truncates to 40 characters", () => {
    const long = "a".repeat(60);
    expect(slugifyBranchPreview(long).length).toBeLessThanOrEqual(40);
  });

  it("returns 'task' for empty or all-symbol input", () => {
    expect(slugifyBranchPreview("")).toBe("task");
    expect(slugifyBranchPreview("!!!")).toBe("task");
  });
});

describe("titleCase", () => {
  it("converts snake_case to Title Case", () => {
    expect(titleCase("hello_world")).toBe("Hello World");
  });

  it("converts kebab-case to Title Case", () => {
    expect(titleCase("foo-bar-baz")).toBe("Foo Bar Baz");
  });
});

describe("formatCount", () => {
  it("uses singular for count of 1", () => {
    expect(formatCount(1, "file")).toBe("1 file");
  });

  it("uses plural for count other than 1", () => {
    expect(formatCount(3, "file")).toBe("3 files");
  });

  it("uses custom plural form", () => {
    expect(formatCount(2, "child", "children")).toBe("2 children");
  });
});
