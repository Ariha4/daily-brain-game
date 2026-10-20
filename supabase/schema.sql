-- Daily Brain Game: Supabase schema
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> New query -> Run.
-- Everyone plays the same challenge each day. One attempt per person per day.
-- "Today" is defined in America/Los_Angeles so the puzzle flips at midnight Pacific.

-- ---------------------------------------------------------------
-- Helper: today's challenge date
-- ---------------------------------------------------------------
create or replace function public.challenge_today()
returns date
language sql
stable
as $$
  select (now() at time zone 'America/Los_Angeles')::date;
$$;

-- ---------------------------------------------------------------
-- Profiles: one row per signed-up user
-- ---------------------------------------------------------------
create table public.profiles (
  id            uuid primary key references auth.users (id) on delete cascade,
  username      text unique not null check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name  text not null check (char_length(display_name) between 1 and 40),
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Anyone signed in can look up profiles (needed to search for friends by username)
create policy "profiles are readable by signed-in users"
  on public.profiles for select
  to authenticated
  using (true);

create policy "users create their own profile"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

create policy "users update their own profile"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ---------------------------------------------------------------
-- Daily challenges: written by the Cloudflare Worker, read by the app
-- ---------------------------------------------------------------
create table public.daily_challenges (
  challenge_date  date primary key,
  game_type       text not null check (game_type in ('reaction_time', 'sequence_memory', 'number_memory')),
  config          jsonb not null,
  created_at      timestamptz not null default now()
);

alter table public.daily_challenges enable row level security;

-- Players can read today's and past challenges, never future ones (no peeking)
create policy "challenges up to today are readable"
  on public.daily_challenges for select
  to authenticated
  using (challenge_date <= public.challenge_today());

-- No insert/update policy: only the service role key (used by the Worker) can write.

-- ---------------------------------------------------------------
-- Friendships: one row per request, accepted or pending
-- ---------------------------------------------------------------
create table public.friendships (
  requester_id  uuid not null references public.profiles (id) on delete cascade,
  addressee_id  uuid not null references public.profiles (id) on delete cascade,
  status        text not null default 'pending' check (status in ('pending', 'accepted')),
  created_at    timestamptz not null default now(),
  primary key (requester_id, addressee_id),
  check (requester_id <> addressee_id)
);

alter table public.friendships enable row level security;

create policy "users see friendships they are part of"
  on public.friendships for select
  to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

create policy "users send friend requests as themselves"
  on public.friendships for insert
  to authenticated
  with check (requester_id = auth.uid() and status = 'pending');

create policy "addressee can accept a request"
  on public.friendships for update
  to authenticated
  using (addressee_id = auth.uid())
  with check (addressee_id = auth.uid() and status = 'accepted');

create policy "either side can remove a friendship"
  on public.friendships for delete
  to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());

-- Helper used by policies: are these two users accepted friends?
-- security definer so it can read friendships regardless of the caller's RLS view
create or replace function public.are_friends(first_user uuid, second_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.friendships
    where status = 'accepted'
      and (
        (requester_id = first_user and addressee_id = second_user)
        or (requester_id = second_user and addressee_id = first_user)
      )
  );
$$;

-- ---------------------------------------------------------------
-- Attempts: one per user per day
-- ---------------------------------------------------------------
create table public.attempts (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  challenge_date  date not null references public.daily_challenges (challenge_date),
  score           integer not null check (score >= 0),
  duration_ms     integer not null check (duration_ms >= 0),
  details         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  unique (user_id, challenge_date)
);

create index attempts_by_date on public.attempts (challenge_date);

alter table public.attempts enable row level security;

-- You see your own attempts and your accepted friends' attempts
create policy "own and friends' attempts are readable"
  on public.attempts for select
  to authenticated
  using (user_id = auth.uid() or public.are_friends(auth.uid(), user_id));

-- You can only submit for yourself, and only for today's challenge
create policy "submit own attempt for today only"
  on public.attempts for insert
  to authenticated
  with check (user_id = auth.uid() and challenge_date = public.challenge_today());

-- No update or delete policy: a submitted score is final.

-- ---------------------------------------------------------------
-- Streak: consecutive days played, counting back from today
-- (or from yesterday, if today isn't played yet, so the streak isn't "lost" mid-day)
-- ---------------------------------------------------------------
create or replace function public.current_streak(target_user uuid default auth.uid())
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  day_being_checked  date := public.challenge_today();
  streak_length      integer := 0;
  played_that_day    boolean;
begin
  -- Only allow checking yourself or an accepted friend
  if target_user <> auth.uid() and not public.are_friends(auth.uid(), target_user) then
    return null;
  end if;

  -- If today isn't played yet, start counting from yesterday
  select exists (
    select 1 from public.attempts
    where user_id = target_user and challenge_date = day_being_checked
  ) into played_that_day;

  if not played_that_day then
    day_being_checked := day_being_checked - 1;
  end if;

  loop
    select exists (
      select 1 from public.attempts
      where user_id = target_user and challenge_date = day_being_checked
    ) into played_that_day;

    exit when not played_that_day;

    streak_length := streak_length + 1;
    day_being_checked := day_being_checked - 1;
  end loop;

  return streak_length;
end;
$$;

-- ---------------------------------------------------------------
-- Leaderboard for a given day: you plus your friends, best score first
-- RLS on attempts already limits rows to you and your friends.
-- ---------------------------------------------------------------
create or replace view public.daily_leaderboard
with (security_invoker = true)
as
select
  attempts.challenge_date,
  attempts.user_id,
  profiles.username,
  profiles.display_name,
  attempts.score,
  attempts.duration_ms,
  attempts.created_at
from public.attempts
join public.profiles on profiles.id = attempts.user_id;

-- Realtime: let the app subscribe to new attempts so the leaderboard updates live
alter publication supabase_realtime add table public.attempts;
