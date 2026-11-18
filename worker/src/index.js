// Daily Brain Game: challenge generator (Cloudflare Worker, runs on a cron schedule)
//
// Every run, it makes sure challenges exist for today and the next 6 days.
// Existing days are never overwritten, so everyone keeps the same puzzle.
// The full puzzle content is stored in `config`, so every phone plays the
// exact same thing without needing a shared random-number algorithm.
// The puzzle-building logic itself lives in ./challenges.js.

import { buildChallengeRows } from "./challenges.js";

const REQUIRED_ENV = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];

export default {
  // Runs on the cron schedule in wrangler.toml
  async scheduled(event, env, ctx) {
    ctx.waitUntil(prepareUpcomingChallenges(env));
  },

  // Lets you trigger it by hand while testing: GET /run with the secret header
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const providedSecret = request.headers.get("x-admin-secret");

    if (requestUrl.pathname !== "/run" || !isCorrectSecret(providedSecret, env.ADMIN_SECRET)) {
      return new Response("Not found", { status: 404 });
    }

    const summary = await prepareUpcomingChallenges(env);
    return Response.json(summary);
  },
};

export async function prepareUpcomingChallenges(env, now = new Date()) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length > 0) {
    throw new Error(`Missing Worker secrets: ${missing.join(", ")}`);
  }

  const challengeRows = buildChallengeRows(now);

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

// An unset or empty ADMIN_SECRET disables the endpoint entirely. The
// comparison touches every byte so response time doesn't reveal how much of
// a guess was right.
export function isCorrectSecret(provided, expected) {
  if (!expected || typeof provided !== "string") {
    return false;
  }
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  let difference = providedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < expectedBytes.length; index++) {
    difference |= expectedBytes[index] ^ (providedBytes[index] ?? 0);
  }
  return difference === 0;
}
