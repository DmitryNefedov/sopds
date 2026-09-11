import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UserFromGetMe, Update } from '@grammyjs/types';
import { createBot } from '../src/bot.js';
import type { BotConfig } from '../src/config.js';
import { CatalogClient } from '../src/api-client.js';
import type { BotBook, BotPage } from '../src/api-client.js';
import { clearAllSessions } from '../src/session.js';
import { pickData, downloadData, moreData } from '../src/callback.js';

// Exercises the whole handler wiring end to end (an update in, the Telegram
// Bot API calls it provokes out), without a real bot token or network: the
// grammY client's `fetch` is swapped for a fake that plays Telegram's side,
// and `botInfo` is supplied directly so the bot skips the real `getMe`.

const BOT_INFO: UserFromGetMe = {
  id: 1,
  is_bot: true,
  first_name: 'sopds',
  username: 'sopds_test_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

const BASE_CONFIG: BotConfig = {
  token: 't',
  apiUrl: 'http://api.local',
  allowedUsers: null,
  allowedChats: null,
};

interface Recorded {
  method: string;
  body: Record<string, unknown>;
}

function fakeTelegram() {
  const calls: Recorded[] = [];
  const fetchFn = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = url.pathname.split('/').pop() ?? '';
    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = {};
      }
    }
    calls.push({ method, body });
    const result = method === 'answerCallbackQuery' ? true : method === 'sendMediaGroup' ? [{}] : {};
    return new Response(JSON.stringify({ ok: true, result }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchFn };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

const book = (id: number, over: Partial<BotBook> = {}): BotBook => ({
  id,
  title: `Book ${id}`,
  format: 'fb2',
  filesize: 1,
  authors: [],
  series: [],
  ...over,
});

function fullPage(items: BotBook[]): BotPage<BotBook> {
  return { items, total: items.length, page: 1, limit: 5, pages: 1, has_next: false, has_prev: false };
}

/** Defaults to a private chat, where Telegram's chat id equals the sender's
 *  user id; pass `chatId` to place the sender inside a group instead (group
 *  chat ids are negative and distinct from any member's user id). */
function messageUpdate(text: string, userId = 100, chatId = userId): Update {
  const commandLength = text.startsWith('/') ? text.split(' ')[0].length : 0;
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 0,
      chat: { id: chatId, type: chatId === userId ? 'private' : 'group' },
      from: { id: userId, is_bot: false, first_name: 'U' },
      text,
      ...(commandLength ? { entities: [{ type: 'bot_command', offset: 0, length: commandLength }] } : {}),
    },
  } as Update;
}

function callbackUpdate(data: string, userId = 100, chatId = userId): Update {
  return {
    update_id: 2,
    callback_query: {
      id: 'cb1',
      from: { id: userId, is_bot: false, first_name: 'U' },
      chat_instance: 'x',
      data,
      message: {
        message_id: 2,
        date: 0,
        chat: { id: chatId, type: chatId === userId ? 'private' : 'group' },
        text: 'previous message',
      },
    },
  } as Update;
}

test.beforeEach(() => clearAllSessions());

test('/start replies with the help text', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(messageUpdate('/start'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'sendMessage');
  assert.match(String(calls[0].body.text), /\/search/);
});

test('/search with no query replies with usage instead of searching', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(messageUpdate('/search'));
  assert.equal(calls.length, 1);
  assert.match(String(calls[0].body.text), /Usage/);
});

test('/search with results sends a media group then a message with pick buttons', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => jsonResponse(fullPage([book(1), book(2)]))) as typeof fetch,
  });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(messageUpdate('/search hobbit'));

  assert.deepEqual(calls.map((c) => c.method), ['sendMediaGroup', 'sendMessage']);
  const media = calls[0].body.media as { media: string }[];
  assert.equal(media.length, 2);
  const keyboard = calls[1].body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row[0].callback_data),
    [pickData(1), pickData(2)],
  );
});

test('picking a book answers the callback and offers its formats', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () =>
      jsonResponse(
        book(5, {
          format: 'fb2',
          download_formats: [
            { format: 'fb2', native: true, convertible: true, url: '/x' },
            { format: 'epub', native: false, convertible: true, url: '/x' },
            { format: 'mobi', native: false, convertible: true, url: '/x' },
          ],
        }),
      )) as typeof fetch,
  });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(callbackUpdate(pickData(5)));

  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'sendMessage']);
  const keyboard = calls[1].body.reply_markup as { inline_keyboard: { callback_data: string }[][] };
  assert.deepEqual(
    keyboard.inline_keyboard.map((row) => row[0].callback_data),
    [downloadData(5, 'fb2'), downloadData(5, 'epub'), downloadData(5, 'mobi')],
  );
});

test('picking a book that vanished (404) reports it rather than throwing', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const notFoundApi = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () =>
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 })) as typeof fetch,
  });
  const bot = createBot(BASE_CONFIG, notFoundApi, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(callbackUpdate(pickData(404)));

  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'sendMessage']);
  assert.match(String(calls[1].body.text), /no longer available/);
});

test('a "more" callback on an unknown session reports it as expired', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(callbackUpdate(moreData('gone1234')));

  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'sendMessage']);
  assert.match(String(calls[1].body.text), /expired/);
});

test('downloading a format streams the file back as a document', async (t) => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({
    baseUrl: 'http://api.local',
    fetchFn: (async () => jsonResponse(book(5))) as typeof fetch,
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(Buffer.from('book bytes'), { status: 200 }));
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(callbackUpdate(downloadData(5, 'fb2')));

  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery', 'sendDocument']);
});

test('a malformed callback just answers the callback query and sends nothing else', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const bot = createBot(BASE_CONFIG, api, {
    botInfo: BOT_INFO,
    client: { fetch: fetchFn },
  });
  await bot.handleUpdate(callbackUpdate('garbage'));
  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);
});

// ---- allowedUsers (TELEGRAM_ALLOWED_USERS) -----------------------------

test('a user outside allowedUsers gets a plain refusal instead of running /search', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = { ...BASE_CONFIG, allowedUsers: new Set([1, 2, 3]) };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(messageUpdate('/search hobbit', 999));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /not authorized/);
});

test('a user outside allowedUsers gets an alert instead of a callback running', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = { ...BASE_CONFIG, allowedUsers: new Set([1, 2, 3]) };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(callbackUpdate(pickData(5), 999));

  assert.deepEqual(calls.map((c) => c.method), ['answerCallbackQuery']);
  assert.equal(calls[0].body.show_alert, true);
  assert.match(String(calls[0].body.text), /not authorized/);
});

test('a user inside allowedUsers is unaffected', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = { ...BASE_CONFIG, allowedUsers: new Set([100]) };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(messageUpdate('/start', 100));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /\/search/);
});

// ---- allowedChats (TELEGRAM_ALLOWED_CHATS) -----------------------------

test('any member of an allowed group can use the bot, even one not individually allowlisted', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  // allowedUsers is set (and does not include 999) - allowedChats grants
  // access independently, not just when allowedUsers is left unrestricted.
  const config: BotConfig = {
    ...BASE_CONFIG,
    allowedUsers: new Set([1, 2, 3]),
    allowedChats: new Set([-100999]),
  };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(messageUpdate('/start', 999, -100999));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /\/search/);
});

test('an allowedUsers member is not blocked by posting from a non-allowlisted group - identity travels with them', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = {
    ...BASE_CONFIG,
    allowedUsers: new Set([100]),
    allowedChats: new Set([-100999]),
  };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  // user 100 is individually trusted, so an OR match still passes even from
  // a group that is not itself on allowedChats.
  await bot.handleUpdate(messageUpdate('/start', 100, -1005555));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /\/search/);
});

test('a user in neither list, posting from a group in neither list, is refused', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = {
    ...BASE_CONFIG,
    allowedUsers: new Set([100]),
    allowedChats: new Set([-100999]),
  };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(messageUpdate('/start', 999, -1005555));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /not authorized/);
});

test('setting only allowedChats still restricts private chats (both are null for "open", not either)', async () => {
  const { calls, fetchFn } = fakeTelegram();
  const api = new CatalogClient({ baseUrl: 'http://api.local' });
  const config: BotConfig = { ...BASE_CONFIG, allowedChats: new Set([-100999]) };
  const bot = createBot(config, api, { botInfo: BOT_INFO, client: { fetch: fetchFn } });

  await bot.handleUpdate(messageUpdate('/start', 12345));

  assert.deepEqual(calls.map((c) => c.method), ['sendMessage']);
  assert.match(String(calls[0].body.text), /not authorized/);
});
