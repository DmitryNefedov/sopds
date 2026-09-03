import type { Request, Response, NextFunction, RequestHandler } from 'express';

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => unknown | Promise<unknown>;

/** Wrap an async route handler so rejected promises reach the error middleware. */
export const ah =
  (fn: AsyncHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

/** First value of a query param as a string. */
export const qstr = (v: unknown, fallback = ''): string => {
  if (Array.isArray(v)) v = v[0];
  return typeof v === 'string' ? v : fallback;
};
