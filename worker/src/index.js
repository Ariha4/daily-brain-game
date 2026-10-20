// Daily Brain Game: challenge generator (Cloudflare Worker, runs on a cron schedule)
//
// Every run, it makes sure challenges exist for today and the next 6 days.
// Existing days are never overwritten, so everyone keeps the same puzzle.
// The full puzzle content is stored in `config`, so every phone plays the
// exact same thing without needing a shared random-number algorithm.

const GAME_ROTATION = ["reaction_time", "sequence_memory", "number_memory"];
const DAYS_TO_PREPARE = 7;

export default {
  // Runs on the cron schedule in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prepareUpcomingChallenges(env));
  },

  // Lets you trigger it by hand while testing: GET /run with the secret header
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const providedSecret = request.headers.get("x-admin-secret");

    if (requestUrl.pathname !== "/run" || providedSecret !== env.ADMIN_SECRET) {
      return new Response("Not found", { status: 404 });
    }

    const summary = await prepareUpcomingChallenges(env);
    return Response.json(summary);
  },
};

async function prepareUpcomingChallenges(env) {
  const challengeRows = [];
  const todayPacific = pacificDateString(new Date());

  for (let dayOffset = 0; dayOffset < DAYS_TO_PREPARE; dayOffset++) {
    const challengeDate = addDays(todayPacific, dayOffset);
    const gameType = pickGameTypeForDate(challengeDate);
    const gameConfig = buildConfig(gameType);

    challengeRows.push({
      challenge_date: challengeDate,
      game_type: gameType,
      config: gameConfig,
    });
  }

  // Insert, skipping any date that already has a challenge
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/daily_challenges`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=ignore-duplicates,return=minimal",
    },
    body: JSON.stringify(challengeRows),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Supabase insert failed (${response.status}): ${errorText}`);
  }

  return {
    ok: true,
    datesChecked: challengeRows.map((row) => `${row.challenge_date} ${row.game_type}`),
  };
}

// Same date always gets the same game type, rotating through the list
function pickGameTypeForDate(dateString) {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const daysSinceEpoch = Math.floor(Date.parse(`${dateString}T00:00:00Z`) / millisecondsPerDay);
  const rotationIndex = daysSinceEpoch % GAME_ROTATION.length;
  return GAME_ROTATION[rotationIndex];
}

function buildConfig(gameType) {
  if (gameType === "reaction_time") {
    // 5 rounds; each waits a random 1.5 to 4 seconds before the screen turns green
    const waitTimesMs = [];
    for (let roundNumber = 0; roundNumber < 5; roundNumber++) {
      waitTimesMs.push(randomIntegerBetween(1500, 4000));
    }
    return { rounds: 5, wait_times_ms: waitTimesMs };
  }

  if (gameType === "sequence_memory") {
    // 3x3 grid; the game shows the first N cells, then N+1, and so on
    const gridSize = 3;
    const cellSequence = [];
    for (let stepNumber = 0; stepNumber < 25; stepNumber++) {
      cellSequence.push(randomIntegerBetween(0, gridSize * gridSize - 1));
    }
    return { grid_size: gridSize, sequence: cellSequence };
  }

  if (gameType === "number_memory") {
    // One number per level, starting at 3 digits; the first digit is never 0
    const numbersByLevel = [];
    for (let digitCount = 3; digitCount <= 15; digitCount++) {
      let numberText = String(randomIntegerBetween(1, 9));
      for (let digitPosition = 1; digitPosition < digitCount; digitPosition++) {
        numberText += String(randomIntegerBetween(0, 9));
      }
      numbersByLevel.push(numberText);
    }
    return { show_time_ms_per_digit: 700, numbers: numbersByLevel };
  }

  throw new Error(`Unknown game type: ${gameType}`);
}

// Inclusive on both ends, using the crypto random source
function randomIntegerBetween(lowest, highest) {
  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  const rangeSize = highest - lowest + 1;
  return lowest + (randomBuffer[0] % rangeSize);
}

// "YYYY-MM-DD" for the given moment in America/Los_Angeles
function pacificDateString(moment) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(moment);
}

function addDays(dateString, numberOfDays) {
  const date = new Date(`${dateString}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + numberOfDays);
  return date.toISOString().slice(0, 10);
}
