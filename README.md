# Flexstaff

Gestion de l'équipe et des droits de **Flex Suite**, les applications qui partagent un même projet Supabase :

| Appli | Dépôt | Rôle |
|---|---|---|
| Flexfolio | `void19845/flexfolio` | Portfolio et son administration |
| Flexform | `void19845/flexform` | Sondages du BDE Montreuil |
| Flexdesign | `void19845/flexdesign` | Design system, studio de visuels et moodboards (en construction) |
| Flexstaff | ce dépôt | Ajouter du staff, transmettre le rôle admin, et socle commun de la base |

Ce dépôt contient :

- **les droits communs** de la base partagée, dans `supabase/init.sql` : tables et fonctions `suite_*`,
  `app_roles`. Chaque appli a son propre `supabase/init.sql` dans son dépôt (ses tables, ses règles de
  sécurité, son inscription dans `suite_apps`), qui s'applique après celui-ci ;
- les scripts de gestion des comptes (`npm run role`) et de test des droits (`npm run test:rls`) ;
- l'appli Flexstaff : ajouter du staff et transmettre le rôle admin depuis une interface.

## Droits

| Table | Contenu | Qui peut la modifier |
|---|---|---|
| `suite_super_admins` | Le ou les vrais admins de toute la suite : admins de toutes les applis | Personne depuis une appli : uniquement en SQL |
| `suite_apps` | Les applis de la suite (`flexfolio`, `flexform`...) | Uniquement en SQL (`init.sql` de chaque appli) |
| `app_roles` | Rôle `admin` ou `staff` d'un compte dans une appli | L'admin de cette appli, ou un super admin |

Les règles RLS de chaque appli appellent `suite_has_app_role('appli', array['admin'])` (ou `staff`). C'est
la base qui décide : une appli ne peut pas donner plus de droits que ceux de son admin, ni créer de super admin.

Thèmes de Flexdesign (`design_themes`, `design_theme_colors`, `design_theme_fonts`, `design_fonts`,
`design_font_files`, fonction `design_save_theme`, bucket public `design-fonts`) : lecture publique, visiteurs
compris (les applis qui se lient à un thème le lisent avec la clé anon) ; écriture réservée aux admins de
Flexdesign et aux super admins. Le staff Flexdesign lit seulement (schéma dans le dépôt flexdesign).

Moodboards de Flexdesign (`design_boards`, `design_board_members`, `design_board_links`, `design_board_items`,
bucket privé `design-assets`) : un tableau n'est visible que par son propriétaire, les membres de l'équipe
Flexdesign qu'il a choisis (lecture ou modification) et, s'il l'ouvre, toute l'équipe en lecture, et seulement
tant qu'ils ont un rôle Flexdesign. Être admin de Flexdesign ou super admin ne donne aucun accès aux tableaux
des autres. Le propriétaire seul gère le titre, le partage, le lien public et la suppression ; les membres en
modification gèrent les images. Le lien public passe par `design_board_by_token` (visiteurs compris).

## Mettre en place la base de production

1. Dans le SQL Editor de Supabase, exécuter dans cet ordre : `supabase/init.sql` de ce dépôt, puis
   `supabase/init.sql` de flexfolio, flexform et flexdesign. Chaque fichier est idempotent : sur un projet
   vierge il crée tout, sur une base existante il ajoute ce qui manque et remet les règles de sécurité à
   jour, sans rien perdre. On relance le fichier d'une appli après chaque modification de son schéma.
2. **Tout de suite après**, se déclarer super admin dans le SQL Editor (sinon plus personne ne peut
   modifier le portfolio) :

   ```sql
   insert into public.suite_super_admins (user_id)
   select id from auth.users where email = 'ton.email@exemple.fr';
   ```

3. Donner les autres rôles avec `npm run role` (ci-dessous), avec les clés de production dans `.env`.

## Gérer les comptes

```bash
npm install
npm run role -- prenom.nom@exemple.fr flexform staff
```

`admin` pour un admin, `remove` pour retirer le rôle (le compte Supabase est conservé). Un compte qui
n'existe pas est créé, avec un mot de passe provisoire affiché une seule fois. `.env` doit contenir
`SUPABASE_URL` et `SUPABASE_SERVICE_ROLE_KEY` (clé secrète : uniquement sur ton poste).

## Importer un export Flexfolio

Un export « flexfolio-pour-ami » (`base-public.sql`, `base-storage.sql`, `supabase-storage-*.tgz`) se
reprend avec `scripts/import-flexfolio.mjs`, **jamais en exécutant ses fichiers SQL** : `base-public.sql`
recrée l'ancien schéma, où tout compte connecté peut modifier le portfolio.

```bash
cd chemin/vers/flexfolio-pour-ami
tar -xzf supabase-storage-*.tgz
cd chemin/vers/flexstaff
node --env-file=.env scripts/import-flexfolio.mjs chemin/vers/flexfolio-pour-ami
node --env-file=.env scripts/import-flexfolio.mjs chemin/vers/flexfolio-pour-ami --apply
```

Sans `--apply`, rien n'est écrit : le script vérifie l'export et la base cible (`setup.sql` appliqué, slugs
déjà pris) et affiche ce qu'il ferait. Avec `--apply`, il envoie les fichiers dans le bucket `project-images`
par l'API Storage, réécrit l'adresse des images vers `NEXT_PUBLIC_SUPABASE_URL` (sinon `SUPABASE_URL`), puis
ajoute ou met à jour projets, images et réglages du site (relancer ne crée pas de doublon). Les anciennes
colonnes `cv_*` de l'export ne sont pas reprises : le schéma actuel ne les a plus. Si les lignes sont
importées par un fichier SQL (SQL Editor de Supabase), `--images-only` n'envoie que les fichiers.

## Base locale et tests

Docker Desktop doit tourner.

```bash
npm run db:start
npx supabase status -o env
```

Copier `API_URL`, `ANON_KEY` et `SERVICE_ROLE_KEY` dans `.env` sous les noms `SUPABASE_URL`,
`SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` (les mêmes valeurs servent aux applis en local).
Créer les comptes de test (`TEST_*` dans `.env`) avec `npm run role`, déclarer `TEST_SUPER_EMAIL` super admin
en SQL (`docker exec -i supabase_db_flexstaff psql -U postgres -c "insert ..."`), puis :

```bash
npm run test:rls
```

`scripts/rls-e2e.mjs` vérifie chaque règle directement dans la base, avec le jeton de chaque rôle
(visiteur, staff et admin Flexform, admin Flexfolio, super admin). Pour les thèmes de Flexdesign, il donne
au staff Flexform un rôle staff Flexdesign le temps du test (retiré à la fin) et vérifie : lecture publique,
écriture et `design_save_theme` refusées à tout autre qu'un admin Flexdesign, thème incomplet ou couleur
invalide refusés par la base, envoi dans `design-fonts` réservé aux admins et limité aux types de police.
Pour les moodboards, il donne aussi à l'admin Flexform un rôle staff Flexdesign et vérifie : tableau invisible
aux autres (super admin compris) tant qu'il n'est pas partagé, membre en lecture sans aucune écriture, membre en
modification limité aux images (colonnes autorisées, fichier dans le dossier du tableau), partage, lien et
réglages réservés au propriétaire, lien public coupé quand le propriétaire quitte l'équipe, fichiers de
`design-assets` soumis aux mêmes droits (SVG et dossiers hors tableau refusés).
Il refuse de tourner sur une autre base que la base locale. `npm run db:reset` repart d'une base vide,
`npm run db:setup` applique les fichiers à la base en place sans rien effacer : dans les deux cas
`supabase/init.sql` de ce dépôt puis celui de flexfolio, flexform et flexdesign, lus dans les dépôts clonés
à côté (dossier Flex Suite), sur la branche où ils se trouvent. `npm run db:stop` arrête la base.

## Modifier le schéma

Pas de fichiers de migration : un seul `supabase/init.sql` par dépôt. Les droits communs se modifient ici,
les tables d'une appli dans le `init.sql` de son dépôt. Chaque fichier reste idempotent
(`create table if not exists`, `add column if not exists`, `create or replace function`,
`drop policy if exists` puis `create policy`...), pour marcher aussi bien sur une base vierge que sur la
production existante. En local : `npm run db:setup` puis `npm run test:rls` ; en production : relancer le
fichier modifié dans le SQL Editor (celui de flexstaff d'abord s'il a changé).

## L'appli Flexstaff

Réservée aux admins d'au moins une appli de la suite (un compte staff ou sans rôle est refusé à la
connexion). Chaque admin ne voit que les applis qu'il administre ; un super admin les voit toutes.

- ajouter un membre par e-mail, en `admin` ou `staff` : un compte qui n'existe pas est créé, avec un mot
  de passe provisoire affiché une seule fois ;
- promouvoir, rétrograder ou retirer un membre ;
- transmettre son rôle admin à un membre : il devient admin, l'ancien admin devient staff (un super admin
  le reste) ;
- changer le mot de passe d'un membre : saisi par l'admin, ou généré et affiché une seule fois si le champ reste
  vide. Seulement si **tous** les rôles du membre sont dans des applis que l'admin administre (un admin Flexform
  ne peut pas prendre la main sur un compte qui a aussi un rôle dans Flexfolio) ; jamais pour un super admin.
  Un mot de passe actuel ne peut pas être affiché : Supabase Auth n'en garde qu'une empreinte (bcrypt) ;
- « Mon mot de passe » : changer le sien, en donnant l'actuel ;
- les super admins apparaissent dans chaque équipe mais ne se gèrent qu'en SQL.

La base décide de tout avec le jeton du compte connecté (fonctions `suite_*`, RLS de `app_roles`) ; elle
refuse de retirer le dernier admin d'une appli quand aucun super admin n'existe. Les droits sont relus à
chaque requête : un admin rétrogradé perd l'accès aussitôt. La clé `service_role` ne sert qu'à créer un
compte ou changer le mot de passe d'un membre (après vérification des droits avec le jeton du compte, fonction
`suite_password_reset_target` pour le mot de passe) et à limiter les tentatives.

### Lancer

Avec la base locale et le `.env` décrits plus haut :

```bash
npm run dev
```

Ouvre http://localhost:8786. `npm run build` puis `npm start` pour la version de production (même port).

### Tester

Avec l'appli lancée et la base locale :

```bash
node --env-file=.env scripts/app-e2e.mjs http://localhost:8786
```

`scripts/app-e2e.mjs` vérifie chaque route (connexion, équipe, ajout, rôles, transmission, mots de passe), dont
les cas refusés. Il crée puis supprime un compte de test et remet les rôles comme au départ.

### Variables d'environnement

| Variable | Rôle |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Projet Supabase (les noms `NEXT_PUBLIC_*` marchent aussi) |
| `SUPABASE_SERVICE_ROLE_KEY` | Clé serveur : création de comptes, mot de passe d'un membre et limite de tentatives |
| `TEST_*` | Comptes de test, pour `npm run test:rls` et `scripts/app-e2e.mjs` uniquement |

## Nouvelle appli

1. Son propre dépôt, cloné dans le dossier Flex Suite à côté des autres, avec un `supabase/init.sql` qui
   vérifie que les droits de la suite existent, s'inscrit dans `suite_apps` et crée ses tables avec des
   règles RLS basées sur `suite_has_app_role('nouvelle-appli', ...)` (modèle : celui de flexdesign).
2. Ce fichier ajouté à `sql_paths` dans `supabase/config.toml` et à `npm run db:setup`.
3. Ses règles dans `scripts/rls-e2e.mjs` (au moins un cas refusé par règle).
