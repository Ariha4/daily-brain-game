# Daily Brain Game

One short brain challenge a day. Everyone gets the same puzzle, gets one try, and compares scores with friends. Streaks keep you coming back.

**Stack:** SwiftUI (iOS app) · Supabase (auth, Postgres, realtime) · Cloudflare Workers (daily puzzle generator)

## How it works

- A Cloudflare Worker runs once a day and creates puzzles for the next 7 days. The full puzzle content is stored in the database, so every phone plays the exact same thing.
- The day flips at midnight Pacific.
- Database rules (row-level security) enforce the game rules, not the app:
  - You can't see tomorrow's puzzle.
  - You can only submit once, only for today, only as yourself.
  - You only see your own and your friends' scores.
- The leaderboard updates live when a friend finishes, using Supabase realtime.

## The three games (rotate daily)

| Game | What happens | Score (higher is better) |
|---|---|---|
| Reaction time | Screen turns green after a random wait, tap as fast as you can, 5 rounds | `max(0, 1000 - average reaction in ms)`; tapping early counts as a miss (that round = 1000 ms) |
| Sequence memory | 3x3 grid flashes a sequence; repeat it; it grows by one each round | Longest sequence repeated correctly |
| Number memory | A number flashes, then disappears; type it back; one more digit each level | Most digits recalled correctly |

## Setup (about 30 minutes, no Xcode needed)

### 1. Supabase
1. Create a free project at supabase.com.
2. SQL Editor → New query → paste all of `supabase/schema.sql` → Run.
3. Authentication → Providers → make sure **Email** is on. Turn on "Email OTP" so people sign in with a 6-digit code (no password, no deep links to set up).
4. Project Settings → API → copy the **Project URL**, the **anon key** (goes in the app), and the **service_role key** (goes in the Worker only, never in the app).

### 2. Cloudflare Worker
```bash
cd worker
npm install
npx wrangler login
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put ADMIN_SECRET        # any long random string you make up
npx wrangler deploy
```
Then run it once by hand so today's puzzle exists:
```bash
curl -H "x-admin-secret: YOUR_ADMIN_SECRET" https://daily-brain-game-challenges.YOUR_SUBDOMAIN.workers.dev/run
```
Check the `daily_challenges` table in Supabase. You should see 7 rows.

### 3. iOS app (once Xcode is installed)
1. Xcode → New Project → iOS App → SwiftUI.
2. File → Add Package Dependencies → `https://github.com/supabase/supabase-swift`.
3. Put the Project URL and anon key in a `Secrets.xcconfig` (already in `.gitignore`).

## One-week plan

| Day | Goal | Done when |
|---|---|---|
| 1 | Supabase + Worker setup (above), Xcode project created, Supabase package added | Today's challenge row exists; app builds |
| 2 | Sign in with email code; create profile (username) on first launch | You can sign in on the simulator and see your profile row |
| 3 | Load today's challenge; build **reaction time** game; submit score | Your attempt appears in Supabase |
| 4 | Build **sequence memory** and **number memory** | All three games playable |
| 5 | Friends: search by username, send/accept requests; leaderboard with live updates; streak | Two accounts can friend each other and see each other's scores live |
| 6 | Polish: animations, haptics, share-your-score card, app icon, empty states | It feels like a real app |
| 7 | Install on 5-10 friends' iPhones by plugging them into your Mac, collect feedback, fix the worst issue | Real people have played it |

## Things to know

- **No paid Apple Developer account needed.** With a free Apple ID, Xcode can install the app on any iPhone plugged into your Mac (Settings → Privacy & Security → Developer Mode on that phone). Limits: the install expires after 7 days, so reinstall weekly, and you can have only a few apps signed this way at once. Fine for a friends beta.
- **TestFlight is optional later.** It needs the $99/year program. Ask a CSE professor or club whether UCSD is enrolled in Apple's free iOS Developer University Program before paying anything.
- **Scores are trusted from the app.** A determined cheater could submit a fake score through the API. Fine for friends; worth mentioning in interviews as a known tradeoff (the fix is validating raw tap timings on the server).
- **Write the Swift yourself, with help.** Use Claude Code or Copilot as you normally do, but make sure you can explain every file. Founders will ask how the realtime leaderboard and the security rules work.
