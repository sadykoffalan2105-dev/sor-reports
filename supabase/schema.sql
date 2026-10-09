-- Платформа «Отчёты СОР/СОЧ»: пользователи, устройства, сессии, учёт работы.
-- Выполнить один раз в Supabase → SQL Editor. Всё взаимодействие идёт через функции (RPC);
-- таблицы для публичного ключа закрыты (RLS без политик).

create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  login text unique not null,
  pass_hash text not null,
  name text not null default '',
  role text not null default 'user' check (role in ('owner', 'user')),
  blocked boolean not null default false,
  note text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists app_devices (
  device_id text not null,
  user_id uuid not null references app_users(id) on delete cascade,
  user_agent text not null default '',
  label text not null default '',
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active_seconds integer not null default 0,
  reports integer not null default 0,
  books integer not null default 0,
  primary key (device_id, user_id)
);

create table if not exists app_sessions (
  token text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  device_id text not null,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  active_seconds integer not null default 0,
  revoked boolean not null default false
);

create table if not exists app_events (
  id bigserial primary key,
  user_id uuid references app_users(id) on delete cascade,
  device_id text not null default '',
  kind text not null,
  qty integer not null default 1,
  info text not null default '',
  at timestamptz not null default now()
);
create index if not exists app_events_user_at on app_events(user_id, at desc);

alter table app_users enable row level security;
alter table app_devices enable row level security;
alter table app_sessions enable row level security;
alter table app_events enable row level security;
revoke all on app_users, app_devices, app_sessions, app_events from anon, authenticated;

-- ---------- вспомогательные ----------

create or replace function app_auth(p_token text) returns app_users
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  select u2.* into u from app_sessions s join app_users u2 on u2.id = s.user_id
   where s.token = p_token and not s.revoked and s.last_seen > now() - interval '60 days';
  if u.id is null then raise exception 'AUTH'; end if;
  if u.blocked then raise exception 'BLOCKED'; end if;
  update app_sessions set last_seen = now() where token = p_token;
  return u;
end $$;

create or replace function app_owner(p_token text) returns app_users
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  u := app_auth(p_token);
  if u.role <> 'owner' then raise exception 'FORBIDDEN'; end if;
  return u;
end $$;

create or replace function app_user_json(u app_users) returns json
language sql immutable as $$
  select json_build_object('id', u.id, 'login', u.login, 'name', u.name, 'role', u.role, 'blocked', u.blocked, 'note', u.note, 'created_at', u.created_at);
$$;

-- ---------- для всех ----------

-- есть ли основатель (для первого запуска панели)
create or replace function app_state() returns json
language sql security definer set search_path = public as $$
  select json_build_object('has_owner', exists(select 1 from app_users where role = 'owner'));
$$;

-- первый запуск: создать основателя (работает только пока основателя нет)
create or replace function app_setup_owner(p_login text, p_password text) returns json
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  if exists(select 1 from app_users where role = 'owner') then raise exception 'OWNER_EXISTS'; end if;
  if length(trim(p_login)) < 3 or length(p_password) < 6 then raise exception 'WEAK'; end if;
  insert into app_users(login, pass_hash, name, role) values (lower(trim(p_login)), crypt(p_password, gen_salt('bf')), 'Основатель', 'owner') returning * into u;
  return app_user_json(u);
end $$;

create or replace function app_login(p_login text, p_password text, p_device_id text, p_user_agent text) returns json
language plpgsql security definer set search_path = public as $$
declare u app_users; t text;
begin
  select * into u from app_users where login = lower(trim(p_login));
  if u.id is null or u.pass_hash <> crypt(p_password, u.pass_hash) then
    perform pg_sleep(0.3); raise exception 'LOGIN';
  end if;
  if u.blocked then raise exception 'BLOCKED'; end if;
  t := encode(gen_random_bytes(32), 'hex');
  insert into app_devices(device_id, user_id, user_agent) values (p_device_id, u.id, left(coalesce(p_user_agent, ''), 300))
    on conflict (device_id, user_id) do update set last_seen = now(), user_agent = excluded.user_agent;
  insert into app_sessions(token, user_id, device_id) values (t, u.id, p_device_id);
  insert into app_events(user_id, device_id, kind) values (u.id, p_device_id, 'login');
  return json_build_object('token', t, 'user', app_user_json(u));
end $$;

create or replace function app_me(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  u := app_auth(p_token);
  return app_user_json(u);
end $$;

-- свои логин и пароль (нужен старый пароль); при смене пароля остальные сессии завершаются
create or replace function app_me_update(p_token text, p_login text, p_password_old text, p_password_new text) returns json
language plpgsql security definer set search_path = public as $$
declare u app_users; l text := lower(trim(coalesce(p_login, '')));
begin
  u := app_auth(p_token);
  if u.pass_hash <> crypt(coalesce(p_password_old, ''), u.pass_hash) then raise exception 'LOGIN'; end if;
  if l <> '' and l <> u.login then
    if length(l) < 3 then raise exception 'WEAK'; end if;
    if exists(select 1 from app_users where login = l) then raise exception 'EXISTS'; end if;
    update app_users set login = l where id = u.id;
  end if;
  if coalesce(p_password_new, '') <> '' then
    if length(p_password_new) < 6 then raise exception 'WEAK'; end if;
    update app_users set pass_hash = crypt(p_password_new, gen_salt('bf')) where id = u.id;
    update app_sessions set revoked = true where user_id = u.id and token <> p_token;
  end if;
  select * into u from app_users where id = u.id;
  return app_user_json(u);
end $$;

create or replace function app_logout(p_token text) returns void
language sql security definer set search_path = public as $$
  update app_sessions set revoked = true where token = p_token;
$$;

-- учёт времени: клиент шлёт раз в минуту, пока вкладка открыта
create or replace function app_heartbeat(p_token text, p_device_id text, p_seconds integer) returns void
language plpgsql security definer set search_path = public as $$
declare u app_users; s integer := least(greatest(coalesce(p_seconds, 0), 0), 600);
begin
  u := app_auth(p_token);
  update app_sessions set active_seconds = active_seconds + s where token = p_token;
  update app_devices set active_seconds = active_seconds + s, last_seen = now() where device_id = p_device_id and user_id = u.id;
end $$;

-- событие: book (скачана книга), report (лист/класс), journal (загружен журнал)
create or replace function app_event(p_token text, p_device_id text, p_kind text, p_qty integer, p_info text) returns void
language plpgsql security definer set search_path = public as $$
declare u app_users; q integer := least(greatest(coalesce(p_qty, 1), 1), 1000);
begin
  u := app_auth(p_token);
  insert into app_events(user_id, device_id, kind, qty, info) values (u.id, p_device_id, left(p_kind, 40), q, left(coalesce(p_info, ''), 200));
  if p_kind = 'book' then update app_devices set books = books + q, last_seen = now() where device_id = p_device_id and user_id = u.id;
  elsif p_kind = 'report' then update app_devices set reports = reports + q, last_seen = now() where device_id = p_device_id and user_id = u.id;
  end if;
end $$;

-- ---------- только основатель ----------

create or replace function app_admin_users(p_token text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  return coalesce((select json_agg(row_to_json(x) order by x.last_seen desc nulls last) from (
    select u.id, u.login, u.name, u.role, u.blocked, u.note, u.created_at,
      (select count(*) from app_devices d where d.user_id = u.id) as devices,
      (select coalesce(sum(d.books), 0) from app_devices d where d.user_id = u.id) as books,
      (select coalesce(sum(d.reports), 0) from app_devices d where d.user_id = u.id) as reports,
      (select coalesce(sum(d.active_seconds), 0) from app_devices d where d.user_id = u.id) as seconds,
      (select max(d.last_seen) from app_devices d where d.user_id = u.id) as last_seen
    from app_users u) x), '[]'::json);
end $$;

create or replace function app_admin_create_user(p_token text, p_login text, p_password text, p_name text, p_note text) returns json
language plpgsql security definer set search_path = public as $$
declare u app_users;
begin
  perform app_owner(p_token);
  if length(trim(p_login)) < 3 or length(p_password) < 6 then raise exception 'WEAK'; end if;
  if exists(select 1 from app_users where login = lower(trim(p_login))) then raise exception 'EXISTS'; end if;
  insert into app_users(login, pass_hash, name, note) values (lower(trim(p_login)), crypt(p_password, gen_salt('bf')), coalesce(p_name, ''), coalesce(p_note, '')) returning * into u;
  return app_user_json(u);
end $$;

create or replace function app_admin_set_blocked(p_token text, p_user_id uuid, p_blocked boolean) returns void
language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := app_owner(p_token);
  if p_user_id = me.id then raise exception 'SELF'; end if;
  update app_users set blocked = p_blocked where id = p_user_id;
  if p_blocked then update app_sessions set revoked = true where user_id = p_user_id; end if;
end $$;

create or replace function app_admin_set_password(p_token text, p_user_id uuid, p_password text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  if length(p_password) < 6 then raise exception 'WEAK'; end if;
  update app_users set pass_hash = crypt(p_password, gen_salt('bf')) where id = p_user_id;
  update app_sessions set revoked = true where user_id = p_user_id;
end $$;

create or replace function app_admin_update_user(p_token text, p_user_id uuid, p_name text, p_note text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  update app_users set name = coalesce(p_name, name), note = coalesce(p_note, note) where id = p_user_id;
end $$;

create or replace function app_admin_delete_user(p_token text, p_user_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare me app_users;
begin
  me := app_owner(p_token);
  if p_user_id = me.id then raise exception 'SELF'; end if;
  delete from app_users where id = p_user_id and role <> 'owner';
end $$;

create or replace function app_admin_devices(p_token text, p_user_id uuid) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  return coalesce((select json_agg(row_to_json(d) order by d.last_seen desc) from app_devices d where d.user_id = p_user_id), '[]'::json);
end $$;

create or replace function app_admin_events(p_token text, p_user_id uuid, p_limit integer) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  return coalesce((select json_agg(row_to_json(e)) from (
    select id, device_id, kind, qty, info, at from app_events where user_id = p_user_id order by at desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) e), '[]'::json);
end $$;

create or replace function app_admin_summary(p_token text) returns json
language plpgsql security definer set search_path = public as $$
begin
  perform app_owner(p_token);
  return json_build_object(
    'users', (select count(*) from app_users where role = 'user'),
    'blocked', (select count(*) from app_users where blocked),
    'devices', (select count(*) from app_devices),
    'books', (select coalesce(sum(books), 0) from app_devices),
    'reports', (select coalesce(sum(reports), 0) from app_devices),
    'seconds', (select coalesce(sum(active_seconds), 0) from app_devices),
    'active_today', (select count(distinct user_id) from app_sessions where last_seen > now() - interval '1 day'));
end $$;

-- доступ публичному ключу только к функциям
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function app_state(), app_setup_owner(text, text), app_login(text, text, text, text), app_me(text), app_me_update(text, text, text, text), app_logout(text),
  app_heartbeat(text, text, integer), app_event(text, text, text, integer, text),
  app_admin_users(text), app_admin_create_user(text, text, text, text, text), app_admin_set_blocked(text, uuid, boolean),
  app_admin_set_password(text, uuid, text), app_admin_update_user(text, uuid, text, text), app_admin_delete_user(text, uuid),
  app_admin_devices(text, uuid), app_admin_events(text, uuid, integer), app_admin_summary(text)
  to anon, authenticated;
