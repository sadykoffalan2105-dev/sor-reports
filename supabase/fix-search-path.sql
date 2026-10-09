-- Если при входе ошибка «function gen_salt(unknown) does not exist»: pgcrypto в Supabase живёт в схеме extensions.
alter function app_setup_owner(text, text) set search_path = public, extensions;
alter function app_login(text, text, text, text) set search_path = public, extensions;
alter function app_me_update(text, text, text, text) set search_path = public, extensions;
alter function app_admin_create_user(text, text, text, text, text) set search_path = public, extensions;
alter function app_admin_set_password(text, uuid, text) set search_path = public, extensions;
