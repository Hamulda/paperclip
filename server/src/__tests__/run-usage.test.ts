import { describe, expect, it } from "vitest";
import {
  normalizeUsageTotals,
  readRawUsageTotals,
  deriveNormalizedUsageDelta,
  formatCount,
  type UsageTotals,
} from "../services/run-usage.js";

describe("normalizeUsageTotals", () => {
  it("returns null for null input", () => {
    expect(normalizeUsageTotals(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeUsageTotals(undefined)).toBeNull();
  });

  it("normalizes valid usage values", () => {
    const result = normalizeUsageTotals({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    });
  });

  it("floors non-integer values", () => {
    const result = normalizeUsageTotals({
      inputTokens: 1000.7,
      outputTokens: 500.3,
      cachedInputTokens: 200.9,
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 200,
    });
  });

  it("clamps negative values to zero", () => {
    const result = normalizeUsageTotals({
      inputTokens: -100,
      outputTokens: -50,
      cachedInputTokens: -20,
    });
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("handles missing fields as zero", () => {
    const result = normalizeUsageTotals({} as any);
    expect(result).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
  });
});

describe("readRawUsageTotals", () => {
  it("returns null for null input", () => {
    expect(readRawUsageTotals(null)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(readRawUsageTotals({})).toBeNull();
  });

  it("returns null for all-zero usage", () => {
    expect(readRawUsageTotals({
      rawInputTokens: 0,
      rawOutputTokens: 0,
      rawCachedInputTokens: 0,
    })).toBeNull();
  });

  it("reads rawInputTokens preferentially over inputTokens", () => {
    const result = readRawUsageTotals({
      rawInputTokens: 1000,
      inputTokens: 500,
    });
    expect(result?.inputTokens).toBe(1000);
  });

  it("normalizes nested raw usage fields", () => {
    const result = readRawUsageTotals({
      rawInputTokens: 1000,
      rawCachedInputTokens: 200,
      rawOutputTokens: 500,
    });
    expect(result).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
    });
  });

  it("falls back to camelCase fields when raw fields are missing", () => {
    const result = readRawUsageTotals({
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
    });
    expect(result).toEqual({
      inputTokens: 1000,
      cachedInputTokens: 200,
      outputTokens: 500,
    });
  });
});

describe("deriveNormalizedUsageDelta", () => {
  it("returns null when current is null", () => {
    expect(deriveNormalizedUsageDelta(null, null)).toBeNull();
  });

  it("returns copy of current when previous is null", () => {
    const current: UsageTotals = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 };
    const result = deriveNormalizedUsageDelta(current, null);
    expect(result).toEqual(current);
    expect(result).not.toBe(current);
  });

  it("computes positive delta when current > previous", () => {
    const current: UsageTotals = { inputTokens: 200, outputTokens: 100, cachedInputTokens: 50 };
    const previous: UsageTotals = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 };
    const result = deriveNormalizedUsageDelta(current, previous);
    expect(result).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 30,
    });
  });

  it("clamps negative delta to zero for fields that decreased", () => {
    const current: UsageTotals = { inputTokens: 50, outputTokens: 25, cachedInputTokens: 10 };
    const previous: UsageTotals = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 };
    const result = deriveNormalizedUsageDelta(current, previous);
    // When current < previous, returns current value (not zero)
    expect(result).toEqual({
      inputTokens: 50,
      outputTokens: 25,
      cachedInputTokens: 10,
    });
  });

  it("handles partial overflow (some fields increase, some decrease)", () => {
    const current: UsageTotals = { inputTokens: 200, outputTokens: 30, cachedInputTokens: 50 };
    const previous: UsageTotals = { inputTokens: 100, outputTokens: 50, cachedInputTokens: 20 };
    const result = deriveNormalizedUsageDelta(current, previous);
    // When current < previous, returns current value
    expect(result).toEqual({
      inputTokens: 100, // 200 - 100
      outputTokens: 30, // 30 < 50, returns current
      cachedInputTokens: 30, // 50 - 20
    });
  });
});

describe("formatCount", () => {
  it("formats zero", () => {
    expect(formatCount(0)).toBe("0");
  });

  it("formats positive integers with locale separator", () => {
    expect(formatCount(1000)).toBe("1,000");
  });

  it("formats large numbers", () => {
    expect(formatCount(1000000)).toBe("1,000,000");
  });

  it("returns 0 for null", () => {
    expect(formatCount(null)).toBe("0");
  });

  it("returns 0 for undefined", () => {
    expect(formatCount(undefined)).toBe("0");
  });

  it("returns 0 for NaN", () => {
    expect(formatCount(NaN)).toBe("0");
  });

  it("returns 0 for Infinity", () => {
    expect(formatCount(Infinity)).toBe("0");
  });

  it("returns 0 for negative Infinity", () => {
    expect(formatCount(-Infinity)).toBe("0");
  });
});
