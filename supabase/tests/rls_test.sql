-- Row-level security tests for supabase/schema.sql.
-- Run after supabase_shim.sql and schema.sql (see .github/workflows/ci.yml).
-- Every check raises an exception on failure, so psql -v ON_ERROR_STOP=1
-- exits non-zero and CI fails.

\set ON_ERROR_STOP 1
set client_min_messages = notice;

create schema tests;
grant usage on schema tests to public;

create function tests.check(condition boolean, description text)
returns void language plpgsql as $$
begin
  if condition is not true then
    raise exception 'FAILED: %', description;
  end if;
  raise notice 'ok - %', description;
end;
$$;

-- Runs a statement that must be rejected (by RLS, a privilege, or a constraint)
create function tests.check_rejected(statement text, description text)
returns void language plpgsql as $$
begin
  execute statement;
  raise exception 'FAILED (statement was allowed): %', description;
exception
  when insufficient_privilege or check_violation or unique_violation then
    raise notice 'ok - %', description;
end;
$$;

-- Switch to the `authenticated` role as the given user, like a request
-- carrying that user's JWT. Pass null to act as a signed-out caller.
create function tests.act_as(user_id uuid)
returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(user_id::text, ''), false),
         set_config('role', case when user_id is null then 'anon' else 'authenticated' end, false);
$$;
grant execute on all functions in schema tests to public;

-- ---------------------------------------------------------------
-- Fixtures (as the table owner): Ana and Ben are friends; Cyrus and Dee are strangers
-- ---------------------------------------------------------------
insert into auth.users (id) values
  ('00000000-0000-0000-0000-00000000000a'),
  ('00000000-0000-0000-0000-00000000000b'),
  ('00000000-0000-0000-0000-00000000000c'),
  ('00000000-0000-0000-0000-00000000000d');

insert into public.profiles (id, username, display_name) values
  ('00000000-0000-0000-0000-00000000000a', 'ana', 'Ana'),
  ('00000000-0000-0000-0000-00000000000b', 'ben', 'Ben'),
  ('00000000-0000-0000-0000-00000000000c', 'cyrus', 'Cyrus'),
  ('00000000-0000-0000-0000-00000000000d', 'dee', 'Dee');

insert into public.daily_challenges (challenge_date, game_type, config)
select public.challenge_today() + offset_days, 'number_memory', '{}'::jsonb
from generate_series(-3, 1) as offset_days;

insert into public.friendships (requester_id, addressee_id, status) values
  ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000b', 'accepted');

-- Ana played the three days before today
insert into public.attempts (user_id, challenge_date, score, duration_ms)
select '00000000-0000-0000-0000-00000000000a', public.challenge_today() - offset_days, 10, 1000
from generate_series(1, 3) as offset_days;

-- ---------------------------------------------------------------
-- Challenges: no peeking at tomorrow
-- ---------------------------------------------------------------
select tests.act_as('00000000-0000-0000-0000-00000000000c');
select tests.check(
  (select count(*) from public.daily_challenges) = 4,
  'players see today and past challenges only');
select tests.check(
  not exists (select 1 from public.daily_challenges where challenge_date > public.challenge_today()),
  'tomorrow''s challenge is hidden');
select tests.check_rejected(
  $$insert into public.daily_challenges values (current_date + 30, 'reaction_time', '{}')$$,
  'players cannot create challenges');

-- ---------------------------------------------------------------
-- Attempts: once, today, as yourself
-- ---------------------------------------------------------------
select tests.act_as('00000000-0000-0000-0000-00000000000a');
insert into public.attempts (user_id, challenge_date, score, duration_ms)
values (auth.uid(), public.challenge_today(), 42, 5000);
select tests.check(true, 'a player can submit today''s attempt');
select tests.check_rejected(
  $$insert into public.attempts (user_id, challenge_date, score, duration_ms)
    values (auth.uid(), public.challenge_today(), 99, 5000)$$,
  'a second attempt for the same day is rejected');
select tests.check_rejected(
  $$insert into public.attempts (user_id, challenge_date, score, duration_ms)
    values (auth.uid(), public.challenge_today() - 4, 99, 5000)$$,
  'attempts for past days are rejected');
select tests.check_rejected(
  $$insert into public.attempts (user_id, challenge_date, score, duration_ms)
    values ('00000000-0000-0000-0000-00000000000c', public.challenge_today(), 99, 5000)$$,
  'submitting on behalf of someone else is rejected');
-- No update policy: the update matches 0 rows instead of raising an error
update public.attempts set score = 1000 where user_id = auth.uid();
select tests.check(
  (select score from public.attempts where challenge_date = public.challenge_today()) = 42,
  'updating a submitted score has no effect');

select tests.act_as('00000000-0000-0000-0000-00000000000b');
select tests.check(
  (select count(*) from public.attempts) = 4,
  'friends can see each other''s attempts');

select tests.act_as('00000000-0000-0000-0000-00000000000c');
select tests.check(
  (select count(*) from public.attempts) = 0,
  'strangers cannot see attempts');

-- ---------------------------------------------------------------
-- Friendships: requests cannot be forged
-- ---------------------------------------------------------------
select tests.act_as('00000000-0000-0000-0000-00000000000c');
insert into public.friendships (requester_id, addressee_id)
values (auth.uid(), '00000000-0000-0000-0000-00000000000b');
select tests.check_rejected(
  $$insert into public.friendships (requester_id, addressee_id, status)
    values (auth.uid(), '00000000-0000-0000-0000-00000000000a', 'accepted')$$,
  'a request cannot be created already accepted');
-- Only the addressee may accept, so this matches 0 rows
update public.friendships set status = 'accepted' where requester_id = auth.uid();
select tests.act_as(null);
select tests.check(
  (select status from public.friendships
   where requester_id = '00000000-0000-0000-0000-00000000000c') is null,
  'signed-out callers cannot read friendships');
reset role;
select tests.check(
  (select status from public.friendships
   where requester_id = '00000000-0000-0000-0000-00000000000c') = 'pending',
  'the requester''s self-accept changed nothing');

-- Ben received Cyrus's request. Accepting it is fine, but he must not be able
-- to rewrite who sent it and make himself "friends" with Dee, who never asked.
select tests.act_as('00000000-0000-0000-0000-00000000000b');
select tests.check_rejected(
  $$update public.friendships
    set requester_id = '00000000-0000-0000-0000-00000000000d', status = 'accepted'
    where requester_id = '00000000-0000-0000-0000-00000000000c'$$,
  'the addressee cannot change who sent a request');
update public.friendships set status = 'accepted'
where requester_id = '00000000-0000-0000-0000-00000000000c';
select tests.check(
  public.are_friends('00000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000c'),
  'the addressee can accept a request');

-- ---------------------------------------------------------------
-- Streaks
-- ---------------------------------------------------------------
select tests.act_as('00000000-0000-0000-0000-00000000000a');
select tests.check(public.current_streak() = 4, 'streak counts today plus 3 prior days');

select tests.act_as('00000000-0000-0000-0000-00000000000b');
select tests.check(public.current_streak() = 0, 'a player with no attempts has no streak');
select tests.check(
  public.current_streak('00000000-0000-0000-0000-00000000000a') = 4,
  'friends can see each other''s streak');

select tests.act_as('00000000-0000-0000-0000-00000000000c');
select tests.check(
  public.current_streak('00000000-0000-0000-0000-00000000000a') is null,
  'strangers cannot see someone''s streak');

select tests.act_as(null);
select tests.check(
  public.current_streak('00000000-0000-0000-0000-00000000000a') is null,
  'signed-out callers cannot see anyone''s streak');

reset role;
