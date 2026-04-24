import { describe, expect, it } from "vitest";

import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  isScrolledNearBottom
} from "./scroll-position";

describe("scroll-position", () => {
  it("calculates the remaining distance from the bottom", () => {
    expect(
      distanceFromBottom({
        scrollHeight: 640,
        scrollTop: 428,
        clientHeight: 180
      })
    ).toBe(32);
  });

  it("clamps overscroll to zero distance", () => {
    expect(
      distanceFromBottom({
        scrollHeight: 640,
        scrollTop: 500,
        clientHeight: 180
      })
    ).toBe(0);
  });

  it("treats only values strictly within the threshold as pinned", () => {
    expect(
      isScrolledNearBottom({
        scrollHeight: 640,
        scrollTop: 429,
        clientHeight: 180
      })
    ).toBe(true);

    expect(
      isScrolledNearBottom({
        scrollHeight: 640,
        scrollTop: 428,
        clientHeight: 180
      })
    ).toBe(false);

    expect(STICK_TO_BOTTOM_THRESHOLD_PX).toBe(32);
  });
});
