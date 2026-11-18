// Pure challenge-building logic, kept separate from the Worker entry point so
// it can be unit tested without Cloudflare or Supabase.
//
// Every function that needs randomness takes a `randomUint32` function, so
// tests can pass a predictable source. Production uses the crypto source.

export const GAME_ROTATION = ["reaction_time", "sequence_memory", "number_memory"];
export const DAYS_TO_PREPARE = 7;

export function cryptoRandomUint32() {
  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  return randomBuffer[0];
}

// Inclusive on both ends. Uses rejection sampling: a plain `value % rangeSize`
// favours the low end whenever 2^32 isn't a multiple of rangeSize.
export function randomIntegerBetween(lowest, highest, randomUint32 = cryptoRandomUint32) {
  const rangeSize = highest - lowest + 1;
  if (!Number.isInteger(rangeSize) || rangeSize < 1) {
    throw new RangeError(`Invalid range ${lowest}..${highest}`);
  }
  const twoTo32 = 2 ** 32;
  const largestFairValue = twoTo32 - (twoTo32 % rangeSize);
  let value = randomUint32();
  while (value >= largestFairValue) {
    value = randomUint32();
  }
  return lowest + (value % rangeSize);
}

// Same date always gets the same game type, rotating through the list
export function pickGameTypeForDate(dateString) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const daysSinceEpoch = Math.floor(Date.parse(`${dateString}T00:00:00Z`) / millisecondsPerDay);
  return GAME_ROTATION[daysSinceEpoch % GAME_ROTATION.length];
}

export function buildConfig(gameType, randomUint32 = cryptoRandomUint32) {
  const between = (lowest, highest) => randomIntegerBetween(lowest, highest, randomUint32);

  if (gameType === "reaction_time") {
    // 5 rounds; each waits a random 1.5 to 4 seconds before the screen turns green
    const waitTimesMs = [];
    for (let roundNumber = 0; roundNumber < 5; roundNumber++) {
      waitTimesMs.push(between(1500, 4000));
    }
    return { rounds: 5, wait_times_ms: waitTimesMs };
  }

  if (gameType === "sequence_memory") {
    // 3x3 grid; the game shows the first N cells, then N+1, and so on.
    // The same cell never flashes twice in a row: on screen that looks like
    // one long flash, so players would "miss" a step they never saw.
    const gridSize = 3;
    const cellCount = gridSize * gridSize;
    const cellSequence = [between(0, cellCount - 1)];
    while (cellSequence.length < 25) {
      const previousCell = cellSequence[cellSequence.length - 1];
      // Pick from the other 8 cells, then shift past the previous one
      const offset = between(1, cellCount - 1);
      cellSequence.push((previousCell + offset) % cellCount);
    }
    return { grid_size: gridSize, sequence: cellSequence };
  }

  if (gameType === "number_memory") {
    // One number per level, starting at 3 digits; the first digit is never 0
    const numbersByLevel = [];
    for (let digitCount = 3; digitCount <= 15; digitCount++) {
      let numberText = String(between(1, 9));
      for (let digitPosition = 1; digitPosition < digitCount; digitPosition++) {
        numberText += String(between(0, 9));
      }
      numbersByLevel.push(numberText);
    }
    return { show_time_ms_per_digit: 700, numbers: numbersByLevel };
  }

  throw new Error(`Unknown game type: ${gameType}`);
}

// "YYYY-MM-DD" for the given moment in America/Los_Angeles
export function pacificDateString(moment) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(moment);
}

export function addDays(dateString, numberOfDays) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + numberOfDays);
  return date.toISOString().slice(0, 10);
}

// The rows the Worker upserts on each run: today (Pacific) plus the next 6 days
export function buildChallengeRows(now, randomUint32 = cryptoRandomUint32) {
  const todayPacific = pacificDateString(now);
  const rows = [];
  for (let dayOffset = 0; dayOffset < DAYS_TO_PREPARE; dayOffset++) {
    const challengeDate = addDays(todayPacific, dayOffset);
    const gameType = pickGameTypeForDate(challengeDate);
    rows.push({
      challenge_date: challengeDate,
      game_type: gameType,
      config: buildConfig(gameType, randomUint32),
    });
  }
  return rows;
}
