-- =====================================================================
-- Flex Suite : droits communs à toutes les applis (à appliquer en premier)
-- =====================================================================
-- Chaque appli a son propre supabase/init.sql dans son dépôt (flexfolio, flexform, flexdesign) et s'y
-- inscrit dans suite_apps. Ce fichier crée les droits partagés dont elles dépendent : il passe avant elles.
-- Il crée aussi, en fin de fichier, les tables de l'appli Flexstaff elle-même (calendrier et tâches).
--
-- Idempotent : relançable tel quel, sur une base vierge comme sur la production existante.
--
--   En local      : npm run db:reset (base vierge : ce fichier puis ceux des applis, voir config.toml)
--                   ou npm run db:setup (les mêmes fichiers, sur la base en place, sans rien effacer)
--   En production : SQL Editor de Supabase, ce fichier d'abord, puis celui de chaque appli
--
-- Ajouter un super admin (une seule fois, dans le SQL Editor) :
--   insert into public.suite_super_admins (user_id)
--   select id from auth.users where email = 'ton.email@exemple.fr';
-- =====================================================================

create extension if not exists "pgcrypto";

--   suite_apps          Les applications de la suite. Une nouvelle appli = une ligne ici.
--   suite_super_admins  Le ou les vrais admins de toute la suite. Aucune appli ne peut y écrire :
--                       on l'édite uniquement en SQL (SQL Editor de Supabase ou clé service_role).
--   app_roles           Les droits par appli : 'admin' ou 'staff'. L'admin d'une appli gère les droits
--                       de cette appli seulement ; un super admin est admin de toutes les applis.
--
-- Erreurs renvoyées par les fonctions (PostgREST traduit PTxxx en statut HTTP xxx) :
--   PT400 'Change ton propre mot de passe depuis « Mon mot de passe ».'
--   PT403 'Réservé aux admins de cette appli.' / 'Réservé aux admins.'
--   PT404 'Appli inconnue.' / 'Membre introuvable.'
--   PT409 'Il doit rester au moins un admin dans cette appli.' / 'Les super admins se gèrent en SQL.' /
--         'Ce membre a aussi un rôle dans une appli que tu n''administres pas ...'

create table if not exists public.suite_apps (
  app text primary key check (app ~ '^[a-z][a-z0-9-]{1,30}$'),
  name text not null
);

create table if not exists public.suite_super_admins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.app_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  app text not null references public.suite_apps (app) on delete cascade,
  role text not null check (role in ('admin', 'staff')),
  created_at timestamptz not null default now(),
  primary key (user_id, app)
);

-- Limite de tentatives côté serveur (clé service_role uniquement)
create table if not exists public.suite_rate_limits (
  key text primary key,
  hits int not null,
  reset_at timestamptz not null
);

-- ---------------------------------------------------------------------
-- Fonctions : à utiliser dans les règles RLS de chaque appli
-- ---------------------------------------------------------------------
-- security definer : lisent les tables de droits sans dépendre de leurs propres règles (pas de récursion)

create or replace function public.suite_is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.suite_super_admins where user_id = auth.uid())
$$;

-- Rôle du compte connecté dans une appli : 'admin', 'staff' ou null. Un super admin est admin partout.
create or replace function public.suite_app_role(p_app text)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when public.suite_is_super_admin() then 'admin'
    else (select role from public.app_roles where user_id = auth.uid() and app = p_app)
  end
$$;

create or replace function public.suite_has_app_role(p_app text, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(public.suite_app_role(p_app) = any (p_roles), false)
$$;

-- anon compris : les règles de lecture publiques (ex. projets visibles de Flexfolio) les appellent.
-- Sans compte connecté, elles répondent simplement « non ».
grant execute on function public.suite_is_super_admin() to anon, authenticated, service_role;
grant execute on function public.suite_app_role(text) to anon, authenticated, service_role;
grant execute on function public.suite_has_app_role(text, text[]) to anon, authenticated, service_role;

-- Applis dont le compte connecté est admin, triées par nom. Vide pour les autres comptes.
create or replace function public.suite_my_apps()
returns table (app text, name text)
language sql
stable
security definer
set search_path = ''
as $$
  select a.app, a.name
  from public.suite_apps a
  where public.suite_app_role(a.app) = 'admin'
  order by a.name, a.app
$$;
revoke execute on function public.suite_my_apps() from public, anon;
grant execute on function public.suite_my_apps() to authenticated;

-- Équipe d'une appli : les droits de app_roles avec l'e-mail du compte, plus chaque super admin
-- avec le rôle 'super' (une seule fois, même s'il a aussi une ligne dans app_roles).
-- Tri : super, admin, staff, puis e-mail.
create or replace function public.suite_team(p_app text)
returns table (user_id uuid, email text, role text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if public.suite_app_role(p_app) is distinct from 'admin' then
    raise sqlstate 'PT403' using message = 'Réservé aux admins de cette appli.';
  end if;
  if not exists (select 1 from public.suite_apps a where a.app = p_app) then
    raise sqlstate 'PT404' using message = 'Appli inconnue.';
  end if;

  return query
  select t.user_id, t.email, t.role, t.created_at
  from (
    select s.user_id, u.email::text as email, 'super'::text as role, s.created_at
    from public.suite_super_admins s
    join auth.users u on u.id = s.user_id
    union all
    select r.user_id, u.email::text, r.role, r.created_at
    from public.app_roles r
    join auth.users u on u.id = r.user_id
    where r.app = p_app
      and not exists (select 1 from public.suite_super_admins s where s.user_id = r.user_id)
  ) t
  order by case t.role when 'super' then 0 when 'admin' then 1 else 2 end, t.email;
end
$$;
revoke execute on function public.suite_team(text) from public, anon;
grant execute on function public.suite_team(text) to authenticated;

-- Identifiant du compte qui a cet e-mail (casse et espaces ignorés), ou null.
-- Réservé aux comptes admins d'au moins une appli : sinon, n'importe qui pourrait tester des e-mails.
create or replace function public.suite_user_id_by_email(p_email text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.suite_apps a where public.suite_app_role(a.app) = 'admin') then
    raise sqlstate 'PT403' using message = 'Réservé aux admins.';
  end if;
  return (
    select u.id from auth.users u
    where lower(u.email) = lower(trim(p_email))
    order by u.created_at
    limit 1
  );
end
$$;
revoke execute on function public.suite_user_id_by_email(text) from public, anon;
grant execute on function public.suite_user_id_by_email(text) to authenticated;

-- Mot de passe d'un membre (Flexstaff) : vérifie, avec le jeton du compte connecté, qu'il peut changer le mot
-- de passe de ce compte, et renvoie son e-mail. Le serveur n'appelle l'API d'administration de Supabase Auth
-- (clé service_role) qu'ensuite. Le compte doit avoir au moins un rôle, et chacun de ses rôles doit être dans
-- une appli que le compte connecté administre : sinon un admin d'une appli prendrait la main sur un compte qui
-- a plus de droits que lui. Jamais un super admin (géré en SQL). Son propre mot de passe se change en donnant
-- l'actuel (POST /api/auth/password), pas ici.
create or replace function public.suite_password_reset_target(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not exists (select 1 from public.suite_apps a where public.suite_app_role(a.app) = 'admin') then
    raise sqlstate 'PT403' using message = 'Réservé aux admins.';
  end if;
  if p_user = auth.uid() then
    raise sqlstate 'PT400' using message = 'Change ton propre mot de passe depuis « Mon mot de passe ».';
  end if;
  if exists (select 1 from public.suite_super_admins s where s.user_id = p_user) then
    raise sqlstate 'PT409' using message = 'Les super admins se gèrent en SQL.';
  end if;
  if not exists (select 1 from public.app_roles r where r.user_id = p_user) then
    raise sqlstate 'PT404' using message = 'Membre introuvable.';
  end if;
  if exists (
    select 1 from public.app_roles r
    where r.user_id = p_user and public.suite_app_role(r.app) is distinct from 'admin'
  ) then
    raise sqlstate 'PT409' using message = 'Ce membre a aussi un rôle dans une appli que tu n''administres pas : demande à un super admin.';
  end if;
  return (select u.email::text from auth.users u where u.id = p_user);
end
$$;
revoke execute on function public.suite_password_reset_target(uuid) from public, anon;
grant execute on function public.suite_password_reset_target(uuid) to authenticated;

-- Compte une tentative et renvoie le nombre de tentatives dans la fenêtre en cours.
create or replace function public.suite_hit_rate_limit(p_key text, p_window_seconds int)
returns int
language sql
volatile
security definer
set search_path = ''
as $$
  insert into public.suite_rate_limits as r (key, hits, reset_at)
  values (p_key, 1, now() + make_interval(secs => p_window_seconds))
  on conflict (key) do update
    set hits = case when r.reset_at < now() then 1 else r.hits + 1 end,
        reset_at = case when r.reset_at < now() then now() + make_interval(secs => p_window_seconds) else r.reset_at end
  returning hits
$$;
revoke execute on function public.suite_hit_rate_limit(text, int) from public, anon, authenticated;
grant execute on function public.suite_hit_rate_limit(text, int) to service_role;

-- ---------------------------------------------------------------------
-- Garde : toujours au moins un admin par appli
-- ---------------------------------------------------------------------
-- Retirer un admin (suppression de sa ligne, ou passage en staff) est refusé s'il ne reste aucun autre
-- admin dans l'appli et qu'aucun super admin n'existe (un super admin peut toujours réparer).
-- Un verrou par appli, tenu jusqu'à la fin de la transaction, sérialise les changements simultanés :
-- deux admins qui se rétrogradent l'un l'autre en même temps ne passent pas tous les deux.
-- Suppression en cascade (compte ou appli supprimés) : la garde ne s'applique pas, sinon il serait
-- impossible de supprimer le compte du dernier admin.
create or replace function public.app_roles_keep_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role is distinct from 'admin') then
    perform pg_advisory_xact_lock(hashtext('app_roles_keep_admin:' || old.app));
    if exists (select 1 from auth.users u where u.id = old.user_id)
      and exists (select 1 from public.suite_apps a where a.app = old.app)
      and not exists (
        select 1 from public.app_roles r
        where r.app = old.app and r.role = 'admin' and r.user_id <> old.user_id
      )
      and not exists (select 1 from public.suite_super_admins)
    then
      raise sqlstate 'PT409' using message = 'Il doit rester au moins un admin dans cette appli.';
    end if;
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$$;
revoke execute on function public.app_roles_keep_admin() from public, anon, authenticated;

drop trigger if exists app_roles_keep_admin on public.app_roles;
create trigger app_roles_keep_admin
  before update or delete on public.app_roles
  for each row execute function public.app_roles_keep_admin();

-- ---------------------------------------------------------------------
-- Sécurité par ligne
-- ---------------------------------------------------------------------

alter table public.suite_apps enable row level security;
alter table public.suite_super_admins enable row level security;
alter table public.app_roles enable row level security;
alter table public.suite_rate_limits enable row level security;

revoke all on public.suite_apps, public.suite_super_admins, public.app_roles from anon;
-- Réservée au serveur : aucune règle, aucun droit pour les visiteurs ni les comptes connectés
revoke all on public.suite_rate_limits from anon, authenticated;

-- Applis : lisibles par tout compte connecté, modifiables seulement en SQL
drop policy if exists "suite_apps_read" on public.suite_apps;
create policy "suite_apps_read" on public.suite_apps
  for select to authenticated using (true);
revoke insert, update, delete, truncate on public.suite_apps from authenticated;

-- Super admins : chacun voit s'il en fait partie. Aucune règle d'écriture : aucune appli ne peut en créer.
drop policy if exists "suite_super_admins_self" on public.suite_super_admins;
create policy "suite_super_admins_self" on public.suite_super_admins
  for select to authenticated using (user_id = (select auth.uid()));
revoke insert, update, delete, truncate on public.suite_super_admins from authenticated;

-- Droits par appli : chacun lit les siens ; l'admin d'une appli lit et gère ceux de son appli
drop policy if exists "app_roles_read" on public.app_roles;
create policy "app_roles_read" on public.app_roles
  for select to authenticated
  using (user_id = (select auth.uid()) or public.suite_app_role(app) = 'admin');

drop policy if exists "app_roles_admin_insert" on public.app_roles;
create policy "app_roles_admin_insert" on public.app_roles
  for insert to authenticated with check (public.suite_app_role(app) = 'admin');

drop policy if exists "app_roles_admin_update" on public.app_roles;
create policy "app_roles_admin_update" on public.app_roles
  for update to authenticated
  using (public.suite_app_role(app) = 'admin')
  with check (public.suite_app_role(app) = 'admin');

drop policy if exists "app_roles_admin_delete" on public.app_roles;
create policy "app_roles_admin_delete" on public.app_roles
  for delete to authenticated using (public.suite_app_role(app) = 'admin');

-- Une mise à jour ne change que le rôle : impossible de déplacer un droit vers un autre compte ou une autre appli
revoke update on public.app_roles from authenticated;
grant update (role) on public.app_roles to authenticated;

-- =====================================================================
-- Flexstaff : calendrier des événements et tâches de l'équipe
-- =====================================================================
-- Flexstaff est aussi une appli de la suite : son équipe (rôles 'admin' et 'staff' dans app_roles, plus les
-- super admins) planifie les événements.
--
--   staff_projects        Un projet = un événement du calendrier : titre, description courte et longue, date de
--                         l'événement, début de la communication, ouverture et fermeture de la billetterie.
--   staff_tasks           Tâches d'un projet : titre, description, échéance (facultative), faite ou non.
--   staff_task_assignees  Qui est sur chaque tâche (plusieurs personnes possibles).
--   staff_team()          Équipe Flexstaff avec les e-mails (choix des personnes, noms sur les tâches).
--
-- Droits : tout est lisible par l'équipe Flexstaff (staff et admins), et par personne d'autre.
--   - les admins créent, modifient et suppriment projets et tâches, et inscrivent ou retirent n'importe quel
--     membre de l'équipe sur une tâche ;
--   - le staff ajoute des tâches, s'inscrit sur une tâche et s'en retire (lui seulement) ;
--   - les personnes inscrites sur une tâche (et les admins) la cochent ou la décochent : c'est la seule
--     colonne que le staff peut changer (garde staff_tasks_guard).
--
-- Erreurs renvoyées (PostgREST traduit PTxxx en statut HTTP xxx) :
--   PT403 'Réservé à l''équipe Flexstaff.' / 'Seuls les admins modifient une tâche : tu peux seulement la cocher.'

insert into public.suite_apps (app, name) values ('flexstaff', 'Flexstaff') on conflict (app) do nothing;

create table if not exists public.staff_projects (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 120),
  short_description text not null check (char_length(short_description) between 1 and 300),
  long_description text not null check (char_length(long_description) between 1 and 4000),
  event_date date not null,
  communication_start date not null,
  ticketing_open date not null,
  ticketing_close date not null,
  created_at timestamptz not null default now(),
  constraint staff_projects_ticketing_order check (ticketing_open <= ticketing_close),
  constraint staff_projects_communication_order check (communication_start <= event_date)
);
create index if not exists staff_projects_event_date on public.staff_projects (event_date);

create table if not exists public.staff_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.staff_projects (id) on delete cascade,
  title text not null check (char_length(title) between 1 and 120),
  description text not null default '' check (char_length(description) <= 2000),
  due_date date,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists staff_tasks_project_id on public.staff_tasks (project_id);

create table if not exists public.staff_task_assignees (
  task_id uuid not null references public.staff_tasks (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists staff_task_assignees_user_id on public.staff_task_assignees (user_id);

-- Compte de l'équipe Flexstaff : rôle dans app_roles ou super admin
create or replace function public.staff_is_member(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.app_roles where user_id = p_user and app = 'flexstaff')
      or exists (select 1 from public.suite_super_admins where user_id = p_user)
$$;

-- Équipe Flexstaff (super, admin, staff, puis e-mail), réservée à l'équipe. Les anciens membres encore
-- inscrits sur une tâche suivent, avec un rôle null, pour que leur nom reste lisible sur la tâche.
create or replace function public.staff_team()
returns table (user_id uuid, email text, role text)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if not public.suite_has_app_role('flexstaff', array['admin', 'staff']) then
    raise sqlstate 'PT403' using message = 'Réservé à l''équipe Flexstaff.';
  end if;

  return query
  select t.user_id, t.email, t.role
  from (
    select s.user_id, u.email::text as email, 'super'::text as role
    from public.suite_super_admins s
    join auth.users u on u.id = s.user_id
    union all
    select r.user_id, u.email::text, r.role
    from public.app_roles r
    join auth.users u on u.id = r.user_id
    where r.app = 'flexstaff'
      and not exists (select 1 from public.suite_super_admins s where s.user_id = r.user_id)
    union all
    select distinct a.user_id, u.email::text, null::text
    from public.staff_task_assignees a
    join auth.users u on u.id = a.user_id
    where not public.staff_is_member(a.user_id)
  ) t
  order by case t.role when 'super' then 0 when 'admin' then 1 when 'staff' then 2 else 3 end, t.email;
end
$$;

revoke execute on function public.staff_is_member(uuid) from public, anon;
revoke execute on function public.staff_team() from public, anon;
grant execute on function public.staff_is_member(uuid) to authenticated;
grant execute on function public.staff_team() to authenticated;

-- Garde : hors admins, une mise à jour d'une tâche ne change que done. Les droits de colonnes ne distinguent
-- pas staff et admins (même rôle Postgres authenticated) : la garde le fait. La clé service_role (sans compte)
-- n'est pas concernée.
create or replace function public.staff_tasks_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is not null
    and not public.suite_has_app_role('flexstaff', array['admin'])
    and (new.title, new.description, new.due_date) is distinct from (old.title, old.description, old.due_date)
  then
    raise sqlstate 'PT403' using message = 'Seuls les admins modifient une tâche : tu peux seulement la cocher.';
  end if;
  return new;
end
$$;
revoke execute on function public.staff_tasks_guard() from public, anon, authenticated;

drop trigger if exists staff_tasks_guard on public.staff_tasks;
create trigger staff_tasks_guard
  before update on public.staff_tasks
  for each row execute function public.staff_tasks_guard();

alter table public.staff_projects enable row level security;
alter table public.staff_tasks enable row level security;
alter table public.staff_task_assignees enable row level security;

revoke all on public.staff_projects, public.staff_tasks, public.staff_task_assignees from anon;
revoke truncate on public.staff_projects, public.staff_tasks, public.staff_task_assignees from authenticated;

-- Projets : lecture par l'équipe, écriture par ses admins
drop policy if exists "staff_projects_select" on public.staff_projects;
create policy "staff_projects_select" on public.staff_projects
  for select to authenticated using ((select public.suite_has_app_role('flexstaff', array['admin', 'staff'])));
drop policy if exists "staff_projects_insert" on public.staff_projects;
create policy "staff_projects_insert" on public.staff_projects
  for insert to authenticated with check ((select public.suite_has_app_role('flexstaff', array['admin'])));
drop policy if exists "staff_projects_update" on public.staff_projects;
create policy "staff_projects_update" on public.staff_projects
  for update to authenticated
  using ((select public.suite_has_app_role('flexstaff', array['admin'])))
  with check ((select public.suite_has_app_role('flexstaff', array['admin'])));
drop policy if exists "staff_projects_delete" on public.staff_projects;
create policy "staff_projects_delete" on public.staff_projects
  for delete to authenticated using ((select public.suite_has_app_role('flexstaff', array['admin'])));
revoke update on public.staff_projects from authenticated;
grant update (title, short_description, long_description, event_date, communication_start, ticketing_open, ticketing_close)
  on public.staff_projects to authenticated;

-- Tâches : lecture et ajout par l'équipe ; modification par les admins, ou cochage par les personnes inscrites
-- (garde staff_tasks_guard) ; suppression par les admins. Une tâche ne change pas de projet.
drop policy if exists "staff_tasks_select" on public.staff_tasks;
create policy "staff_tasks_select" on public.staff_tasks
  for select to authenticated using ((select public.suite_has_app_role('flexstaff', array['admin', 'staff'])));
drop policy if exists "staff_tasks_insert" on public.staff_tasks;
create policy "staff_tasks_insert" on public.staff_tasks
  for insert to authenticated with check ((select public.suite_has_app_role('flexstaff', array['admin', 'staff'])));
drop policy if exists "staff_tasks_update" on public.staff_tasks;
create policy "staff_tasks_update" on public.staff_tasks
  for update to authenticated
  using (
    (select public.suite_has_app_role('flexstaff', array['admin']))
    or (
      (select public.suite_has_app_role('flexstaff', array['staff']))
      and exists (select 1 from public.staff_task_assignees a where a.task_id = staff_tasks.id and a.user_id = (select auth.uid()))
    )
  )
  with check (
    (select public.suite_has_app_role('flexstaff', array['admin']))
    or (
      (select public.suite_has_app_role('flexstaff', array['staff']))
      and exists (select 1 from public.staff_task_assignees a where a.task_id = staff_tasks.id and a.user_id = (select auth.uid()))
    )
  );
drop policy if exists "staff_tasks_delete" on public.staff_tasks;
create policy "staff_tasks_delete" on public.staff_tasks
  for delete to authenticated using ((select public.suite_has_app_role('flexstaff', array['admin'])));
revoke update on public.staff_tasks from authenticated;
grant update (title, description, due_date, done) on public.staff_tasks to authenticated;

-- Inscriptions : lecture par l'équipe ; chacun s'inscrit ou se retire lui-même, les admins inscrivent ou
-- retirent n'importe qui. On n'inscrit qu'un membre de l'équipe. Pas de modification : on retire puis inscrit.
drop policy if exists "staff_task_assignees_select" on public.staff_task_assignees;
create policy "staff_task_assignees_select" on public.staff_task_assignees
  for select to authenticated using ((select public.suite_has_app_role('flexstaff', array['admin', 'staff'])));
drop policy if exists "staff_task_assignees_insert" on public.staff_task_assignees;
create policy "staff_task_assignees_insert" on public.staff_task_assignees
  for insert to authenticated
  with check (
    (select public.suite_has_app_role('flexstaff', array['admin', 'staff']))
    and (user_id = (select auth.uid()) or (select public.suite_has_app_role('flexstaff', array['admin'])))
    and public.staff_is_member(user_id)
  );
drop policy if exists "staff_task_assignees_delete" on public.staff_task_assignees;
create policy "staff_task_assignees_delete" on public.staff_task_assignees
  for delete to authenticated
  using (
    (select public.suite_has_app_role('flexstaff', array['admin']))
    or (user_id = (select auth.uid()) and (select public.suite_has_app_role('flexstaff', array['staff'])))
  );
revoke update on public.staff_task_assignees from authenticated;
