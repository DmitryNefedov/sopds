// Encodes/decodes inline-keyboard `callback_data`. Telegram caps it at 64
// bytes, so this is the one place that format has to stay disciplined — every
// button the bot sends goes through a builder here, every callback_query
// handler goes through `parseCallback`.

export const MAX_CALLBACK_DATA_BYTES = 64;

export type CallbackAction =
  | { kind: 'more'; token: string }
  | { kind: 'pick'; bookId: number }
  | { kind: 'download'; bookId: number; format: string };

export function moreData(token: string): string {
  return `m:${token}`;
}

export function pickData(bookId: number): string {
  return `p:${bookId}`;
}

export function downloadData(bookId: number, format: string): string {
  return `d:${bookId}:${format}`;
}

const INT = /^\d+$/;

/** Null for anything malformed or unrecognised — a handler treats that the
 *  same as a stale button, rather than throwing on it. */
export function parseCallback(data: string): CallbackAction | null {
  const [kind, ...rest] = data.split(':');
  if (kind === 'm' && rest.length === 1 && rest[0]) return { kind: 'more', token: rest[0] };
  if (kind === 'p' && rest.length === 1 && INT.test(rest[0])) {
    return { kind: 'pick', bookId: Number(rest[0]) };
  }
  if (kind === 'd' && rest.length === 2 && INT.test(rest[0]) && rest[1]) {
    return { kind: 'download', bookId: Number(rest[0]), format: rest[1] };
  }
  return null;
}
