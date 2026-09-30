# Title-only prefix search for the Telegram bot

Status: accepted

The Telegram bot's `/search` is specified to search **book titles only**. No
endpoint does that: `GET /api/search?type=books` looks title-scoped but is not —
`BOOK_MATCH_IDS` (`server/src/services/catalog.ts`) unions three branches
(`books.search_title`, `authors.search_full_name`, `series.search_ser`), so
querying an author's name returns that author's books even though no title
matches. The only title-scoped path is `GET /api/books?prefix=`, which is
prefix-anchored. We chose it, accepting prefix matching in order to keep the bot
a pure client with no changes to `server/`.

## Considered options

- **`GET /api/search?type=books`** — substring matching, correct pagination, but
  matches authors and series too. Rejected: it answers a title search with books
  whose titles do not contain the query.
- **Add a title-only substring mode to the server** (e.g. `fields=title` on
  `/api/search`, which is just the first branch of `BOOK_MATCH_IDS`) — exactly
  the right semantics. Rejected *for now* only to keep the bot strictly
  additive; this is the preferred fix if prefix matching proves too limiting.
- **Filter `type=books` results client-side** — rejected: `total` and `has_next`
  would describe the unfiltered set, breaking both the page-of-five guarantee
  and the "more" button.

## Consequences

- A word from the middle of a title does not match. `normalize()` only
  upper-cases and trims — it does not strip leading articles — so "hitchhiker"
  finds nothing, because the title begins with "The".
- Mitigated, not fixed, by a fallback: when the prefix search returns nothing the
  bot retries via `type=books` and labels those results as having matched
  anywhere, so a dead end becomes an explicit widening rather than silence.
- Adopting the `fields=title` server mode later would let the bot drop that
  fallback and would not change any vocabulary — **Title prefix search** is the
  only term that would need revisiting.
