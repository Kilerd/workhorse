export const REVIEW_JSON_BLOCK_PATTERN = /```json\s*([\s\S]*?)```/giu;

export interface ParsedReviewResult {
  verdict: "approve" | "comment" | "request_changes";
  summary: string;
}

export function isStructuredReviewPayload(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return false;
    }

    const record = parsed as Record<string, unknown>;
    return (
      typeof record.summary === "string" &&
      typeof record.verdict === "string"
    );
  } catch {
    return false;
  }
}

function trimReviewMetadataValue(value: string, maxLength = 4_000): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength).trim();
}

export function extractReviewResult(text: string): ParsedReviewResult | null {
  const matches = [...text.matchAll(REVIEW_JSON_BLOCK_PATTERN)];
  const candidates = matches.length > 0 ? matches.map((match) => match[1] ?? "") : [text];

  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const candidate = candidates[index]?.trim();
    if (!candidate) {
      continue;
    }

    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object") {
        continue;
      }

      const record = parsed as Record<string, unknown>;
      const verdict =
        typeof record.verdict === "string" ? record.verdict.trim().toLowerCase() : "";
      const summary =
        typeof record.summary === "string" ? trimReviewMetadataValue(record.summary) : "";

      if (
        (verdict === "approve" ||
          verdict === "comment" ||
          verdict === "request_changes") &&
        summary
      ) {
        return {
          verdict,
          summary
        };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function stripStructuredReviewBlocks(text: string): string {
  return text
    .replace(REVIEW_JSON_BLOCK_PATTERN, (match, payload: string) =>
      isStructuredReviewPayload(payload.trim()) ? "" : match
    )
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}
