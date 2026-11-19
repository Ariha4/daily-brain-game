import { describe, expect, it } from "vitest";
import {
  DAYS_TO_PREPARE,
  GAME_ROTATION,
  addDays,
  buildChallengeRows,
  buildConfig,
  pacificDateString,
  pickGameTypeForDate,
  randomIntegerBetween,
} from "../src/challenges.js";

// Returns the given values in order, then repeats the last one
function scriptedRandom(...values) {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe("randomIntegerBetween", () => {
  it("maps random values into the inclusive range", () => {
    expect(randomIntegerBetween(0, 9, scriptedRandom(0))).toBe(0);
    expect(randomIntegerBetween(0, 9, scriptedRandom(9))).toBe(9);
    expect(randomIntegerBetween(1500, 4000, scriptedRandom(2501))).toBe(1500);
  });

  it("rejects values in the biased tail instead of wrapping them", () => {
    // 2^32 % 10 === 6, so the top 6 values would skew results toward 0-5
    const biasedValue = 2 ** 32 - 1;
    expect(randomIntegerBetween(0, 9, scriptedRandom(biasedValue, 7))).toBe(7);
  });

  it("throws on an empty or non-integer range", () => {
    expect(() => randomIntegerBetween(5, 4)).toThrow(RangeError);
    expect(() => randomIntegerBetween(0, 1.5)).toThrow(RangeError);
  });

  it("stays in range with the real crypto source", () => {
    for (let i = 0; i < 1000; i++) {
      const value = randomIntegerBetween(1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });
});

describe("pickGameTypeForDate", () => {
  it("rotates through every game on consecutive days", () => {
    const start = "2026-11-01";
    const games = [0, 1, 2].map((offset) => pickGameTypeForDate(addDays(start, offset)));
    expect(new Set(games)).toEqual(new Set(GAME_ROTATION));
    expect(pickGameTypeForDate(addDays(start, 3))).toBe(games[0]);
  });

  it("is deterministic for a given date", () => {
    expect(pickGameTypeForDate("2027-03-14")).toBe(pickGameTypeForDate("2027-03-14"));
  });
});

describe("pacificDateString", () => {
  it("flips at midnight Pacific, not midnight UTC", () => {
    // 07:59 UTC on Nov 19 is still 23:59 on Nov 18 in PST (UTC-8)
    expect(pacificDateString(new Date("2026-11-19T07:59:00Z"))).toBe("2026-11-18");
    expect(pacificDateString(new Date("2026-11-19T08:00:00Z"))).toBe("2026-11-19");
  });

  it("uses the daylight-saving offset in summer", () => {
    // PDT is UTC-7
    expect(pacificDateString(new Date("2026-07-04T06:59:00Z"))).toBe("2026-07-03");
    expect(pacificDateString(new Date("2026-07-04T07:00:00Z"))).toBe("2026-07-04");
  });
});

describe("addDays", () => {
  it("crosses month, year, and leap-day boundaries", () => {
    expect(addDays("2026-11-30", 1)).toBe("2026-12-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29");
  });

  it("is unaffected by daylight saving transitions", () => {
    expect(addDays("2026-03-07", 1)).toBe("2026-03-08");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-11-01", 1)).toBe("2026-11-02");
  });
});

describe("buildConfig", () => {
  it("builds 5 reaction rounds with waits between 1.5 and 4 seconds", () => {
    const config = buildConfig("reaction_time");
    expect(config.rounds).toBe(5);
    expect(config.wait_times_ms).toHaveLength(5);
    for (const wait of config.wait_times_ms) {
      expect(wait).toBeGreaterThanOrEqual(1500);
      expect(wait).toBeLessThanOrEqual(4000);
    }
  });

  it("builds a 25-step sequence on a 3x3 grid", () => {
    const config = buildConfig("sequence_memory");
    expect(config.grid_size).toBe(3);
    expect(config.sequence).toHaveLength(25);
    for (const cell of config.sequence) {
      expect(cell).toBeGreaterThanOrEqual(0);
      expect(cell).toBeLessThanOrEqual(8);
    }
  });

  it("never flashes the same cell twice in a row", () => {
    // A source that always returns 0 used to produce [0, 0, 0, ...]
    const config = buildConfig("sequence_memory", scriptedRandom(0));
    for (let step = 1; step < config.sequence.length; step++) {
      expect(config.sequence[step]).not.toBe(config.sequence[step - 1]);
    }
    for (let run = 0; run < 200; run++) {
      const { sequence } = buildConfig("sequence_memory");
      expect(sequence.some((cell, i) => i > 0 && cell === sequence[i - 1])).toBe(false);
    }
  });

  it("builds numbers from 3 to 15 digits with no leading zero", () => {
    const config = buildConfig("number_memory", scriptedRandom(0));
    expect(config.show_time_ms_per_digit).toBe(700);
    expect(config.numbers.map((n) => n.length)).toEqual(
      Array.from({ length: 13 }, (_, i) => i + 3),
    );
    for (const numberText of config.numbers) {
      expect(numberText).toMatch(/^[1-9][0-9]*$/);
    }
  });

  it("rejects unknown game types", () => {
    expect(() => buildConfig("chess")).toThrow("Unknown game type: chess");
  });
});

describe("buildChallengeRows", () => {
  it("prepares 7 consecutive Pacific dates starting today", () => {
    // 2026-11-19 05:00 UTC is still the evening of Nov 18 in California
    const rows = buildChallengeRows(new Date("2026-11-19T05:00:00Z"));
    expect(rows).toHaveLength(DAYS_TO_PREPARE);
    expect(rows.map((row) => row.challenge_date)).toEqual([
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-21",
      "2026-11-22",
      "2026-11-23",
      "2026-11-24",
    ]);
    for (const row of rows) {
      expect(row.game_type).toBe(pickGameTypeForDate(row.challenge_date));
      expect(row.config).toBeTypeOf("object");
    }
  });
});
