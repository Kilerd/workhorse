import { describe, expect, it } from "vitest";

import {
  extractReviewResult,
  isStructuredReviewPayload,
  stripStructuredReviewBlocks
} from "./review-parser.js";

describe("isStructuredReviewPayload", () => {
  it("returns true for valid review payloads", () => {
    expect(
      isStructuredReviewPayload(
        '{"verdict":"approve","summary":"Looks good"}'
      )
    ).toBe(true);
  });

  it("returns false for non-JSON input", () => {
    expect(isStructuredReviewPayload("not json")).toBe(false);
  });

  it("returns false for JSON missing required fields", () => {
    expect(isStructuredReviewPayload('{"verdict":"approve"}')).toBe(false);
    expect(isStructuredReviewPayload('{"summary":"ok"}')).toBe(false);
  });

  it("returns false for non-object JSON", () => {
    expect(isStructuredReviewPayload('"just a string"')).toBe(false);
    expect(isStructuredReviewPayload("42")).toBe(false);
  });
});

describe("extractReviewResult", () => {
  it("extracts review from a json code block", () => {
    const text = [
      "Some explanation",
      "```json",
      '{"verdict":"request_changes","summary":"Add tests"}',
      "```"
    ].join("\n");

    const result = extractReviewResult(text);
    expect(result).toEqual({
      verdict: "request_changes",
      summary: "Add tests"
    });
  });

  it("returns the last valid review block when multiple exist", () => {
    const text = [
      "```json",
      '{"verdict":"approve","summary":"First"}',
      "```",
      "```json",
      '{"verdict":"comment","summary":"Second"}',
      "```"
    ].join("\n");

    const result = extractReviewResult(text);
    expect(result).toEqual({ verdict: "comment", summary: "Second" });
  });

  it("falls back to parsing the raw text when no code blocks", () => {
    const result = extractReviewResult(
      '{"verdict":"approve","summary":"LGTM"}'
    );
    expect(result).toEqual({ verdict: "approve", summary: "LGTM" });
  });

  it("returns null for invalid verdict values", () => {
    expect(
      extractReviewResult('{"verdict":"reject","summary":"No"}')
    ).toBeNull();
  });

  it("returns null when summary is empty", () => {
    expect(
      extractReviewResult('{"verdict":"approve","summary":""}')
    ).toBeNull();
  });

  it("returns null for unparseable text", () => {
    expect(extractReviewResult("just some text")).toBeNull();
  });

  it("trims long summaries to 4000 chars", () => {
    const longSummary = "x".repeat(5000);
    const text = `{"verdict":"approve","summary":"${longSummary}"}`;
    const result = extractReviewResult(text);
    expect(result?.summary.length).toBeLessThanOrEqual(4000);
  });
});

describe("stripStructuredReviewBlocks", () => {
  it("removes json code blocks containing review payloads", () => {
    const text = [
      "Here is my review.",
      "",
      "```json",
      '{"verdict":"approve","summary":"LGTM"}',
      "```",
      "",
      "End of review."
    ].join("\n");

    const result = stripStructuredReviewBlocks(text);
    expect(result).not.toContain("```json");
    expect(result).toContain("Here is my review.");
    expect(result).toContain("End of review.");
  });

  it("preserves non-review json code blocks", () => {
    const text = [
      "Config example:",
      "```json",
      '{"port": 3000}',
      "```"
    ].join("\n");

    const result = stripStructuredReviewBlocks(text);
    expect(result).toContain("```json");
    expect(result).toContain('"port": 3000');
  });

  it("collapses excess blank lines", () => {
    const text = [
      "Before.",
      "",
      "",
      "",
      "",
      "After."
    ].join("\n");

    expect(stripStructuredReviewBlocks(text)).toBe("Before.\n\nAfter.");
  });
});
