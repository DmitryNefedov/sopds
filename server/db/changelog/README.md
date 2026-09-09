# Database schema

`changelog.sql` is the single source of truth for the catalog schema — tables
and indexes. It is a [Liquibase *formatted SQL*
changelog](https://docs.liquibase.com/concepts/changelogs/sql-format.html):
every Liquibase directive (`--liquibase formatted sql`, `--changeset …`) is a
plain SQL `--` comment, so the file is **also** valid SQL.

That dual nature is deliberate — two consumers:

| Consumer | How it uses the file |
| --- | --- |
| **Compose `postgres` image** (`server/Dockerfile.postgres`) | `liquibase update` runs against a throwaway server at image-build time; the dump — schema **plus** `DATABASECHANGELOG` — is baked into `/docker-entrypoint-initdb.d`. |
| **`initSchema()`** (`server/src/db/schema.ts`) | `npm run dev` against a plain Postgres, and the PGlite test backend (which Liquibase cannot target), execute the file verbatim. Every statement is `… IF NOT EXISTS`, so re-running is a no-op. |

## Changing the schema

Append a new changeset — never edit one that has shipped:

```sql
--changeset sopds:011-books-add-rating
ALTER TABLE books ADD COLUMN IF NOT EXISTS rating INTEGER NOT NULL DEFAULT 0;
```

Then rebuild the `postgres` image (`docker compose build postgres`). The baked
init script only runs on a **fresh** data directory; to migrate a database that
already has data, run Liquibase against it directly before deploying.

## Regenerating the baked SQL by hand

```bash
docker run --rm -v "$PWD/server/db/changelog:/liquibase/changelog:ro" \
  liquibase/liquibase:4.31-alpine \
  --changelog-file=changelog/changelog.sql \
  --url="offline:postgresql?version=16" \
  update-sql
```
