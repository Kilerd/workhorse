export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export const STICK_TO_BOTTOM_THRESHOLD_PX = 32;

export function distanceFromBottom({
  scrollHeight,
  scrollTop,
  clientHeight
}: ScrollMetrics): number {
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

export function isScrolledNearBottom(
  metrics: ScrollMetrics,
  threshold = STICK_TO_BOTTOM_THRESHOLD_PX
): boolean {
  return distanceFromBottom(metrics) < threshold;
}
