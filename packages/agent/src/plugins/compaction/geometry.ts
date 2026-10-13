// The geometry shapes are core-owned seam types; this module implements against them.
import type {
  CompactionGeometry,
  CompactionGeometryInput as CompactionGeometryOptions,
} from "../../core/api";

export type { CompactionYield } from "../../core/api";

const MIN_THRESHOLD_RATIO = 0.4;
const MAX_THRESHOLD_RATIO = 0.85;

export function baseThresholdRatioForWindow(contextWindowTokens: number): number {
  if (contextWindowTokens <= 16_000) return 0.45;
  if (contextWindowTokens <= 32_000) return 0.5;
  if (contextWindowTokens <= 64_000) return 0.55;
  if (contextWindowTokens <= 128_000) return 0.6;
  if (contextWindowTokens <= 512_000) return 0.7;
  return 0.8;
}

export function resolveCompactionGeometry(options: CompactionGeometryOptions): CompactionGeometry {
  const window = Math.max(0, options.contextWindowTokens);
  const previousRatio =
    options.previousYield === undefined || options.previousYield.tokensBefore <= 0
      ? undefined
      : options.previousYield.savedTokens / options.previousYield.tokensBefore;
  const feedback =
    previousRatio === undefined ? 0 : previousRatio > 0.5 ? -0.05 : previousRatio < 0.1 ? 0.05 : 0;
  const thresholdRatio = Math.min(
    MAX_THRESHOLD_RATIO,
    Math.max(MIN_THRESHOLD_RATIO, baseThresholdRatioForWindow(window) + feedback),
  );
  const configuredReserve = Number.isFinite(options.reserveTokens)
    ? Math.max(0, options.reserveTokens ?? 0)
    : 0;
  const reserveTokens = Math.min(
    window,
    Math.max(configuredReserve, Math.min(window * 0.04, 49_152)),
  );
  const ratioThreshold = window * thresholdRatio;
  const thresholdTokens = Math.max(0, Math.min(ratioThreshold, window - reserveTokens));
  const leadTokens = Math.min(32_768, Math.max(8_192, thresholdTokens * 0.125));

  return {
    thresholdRatio,
    thresholdTokens,
    reserveTokens,
    leadTokens,
    prepareTokens: Math.max(0, thresholdTokens - leadTokens),
    graceTokens: Math.max(
      thresholdTokens,
      Math.min(thresholdTokens + leadTokens, window - reserveTokens),
    ),
  };
}
