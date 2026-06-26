import { describe, expect, it } from "vitest";
import { formatSessionDate, formatSessionEventTime, formatRelativeTime } from "./time";

describe("formatSessionDate", () => {
  it("returns a short month and day for a given timestamp", () => {
    // Use a fixed date: 2024-06-15 at noon UTC
    const ts = new Date("2024-06-15T12:00:00Z").getTime();
    const result = formatSessionDate(ts);
    // The result is locale-dependent but must contain the day number 15
    expect(result).toMatch(/15/);
  });

  it("returns different strings for dates in different months", () => {
    const jan = new Date("2024-01-10T12:00:00Z").getTime();
    const dec = new Date("2024-12-10T12:00:00Z").getTime();
    expect(formatSessionDate(jan)).not.toBe(formatSessionDate(dec));
  });
});

describe("formatSessionEventTime", () => {
  it("returns a time string for a seconds-based timestamp", () => {
    const result = formatSessionEventTime(0);
    // Should be some HH:MM pattern
    expect(result).toMatch(/\d{2}:\d{2}/);
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for a very recent timestamp", () => {
    expect(formatRelativeTime(Date.now() - 500)).toBe("just now");
  });

  it("returns minutes for a timestamp a few minutes ago", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60 * 1000)).toBe("5m");
  });

  it("returns hours for a timestamp a few hours ago", () => {
    expect(formatRelativeTime(Date.now() - 3 * 60 * 60 * 1000)).toBe("3h");
  });

  it("returns days for a timestamp a few days ago", () => {
    expect(formatRelativeTime(Date.now() - 2 * 24 * 60 * 60 * 1000)).toBe("2d");
  });

  it("returns 'in Xm' for a timestamp a few minutes in the future", () => {
    expect(formatRelativeTime(Date.now() + 5 * 60 * 1000)).toBe("in 5m");
  });

  it("returns 'in Xh' for a timestamp a few hours in the future", () => {
    expect(formatRelativeTime(Date.now() + 3 * 60 * 60 * 1000)).toBe("in 3h");
  });

  it("returns 'in Xd' for a timestamp a few days in the future", () => {
    expect(formatRelativeTime(Date.now() + 2 * 24 * 60 * 60 * 1000)).toBe("in 2d");
  });
});
