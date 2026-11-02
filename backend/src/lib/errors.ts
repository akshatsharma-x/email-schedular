import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError } from 'zod';
import { logger } from './logger.js';

/**
 * One error shape for the whole API:
 *   { error: { code, message, details? } }
 * The frontend's typed client relies on exactly this envelope.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError(400, 'BAD_REQUEST', message, details);
export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, 'UNAUTHORIZED', message);
export const forbidden = (message = 'Not allowed') => new AppError(403, 'FORBIDDEN', message);
export const notFound = (message = 'Not found') => new AppError(404, 'NOT_FOUND', message);
export const conflict = (message: string, details?: unknown) =>
  new AppError(409, 'CONFLICT', message, details);
export const failedDependency = (message: string, details?: unknown) =>
  new AppError(424, 'FAILED_DEPENDENCY', message, details);

/** Wraps an async handler so rejections reach the error middleware. */
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    void fn(req, res, next).catch(next);
  };

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }

  if (err instanceof AppError) {
    // 4xx is a client problem, not a server incident -- log it quietly.
    const level = err.status >= 500 ? 'error' : 'warn';
    logger[level]({ err, code: err.code, path: req.path }, err.message);
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
    return;
  }

  // Postgres constraint violations are usually a client-correctable situation,
  // not a server fault. Reporting them as a bare 500 ("something went wrong on
  // our side") tells the user nothing they can act on.
  const pg = err as { code?: string; constraint?: string } | null;
  if (pg?.code === '23503') {
    logger.warn(
      { constraint: pg.constraint, path: req.path },
      'foreign key violation -- referenced row is gone',
    );
    res.status(409).json({
      error: {
        code: 'STALE_REFERENCE',
        message:
          'Something this action referred to no longer exists. Sign out and back in, then try again.',
      },
    });
    return;
  }
  if (pg?.code === '23505') {
    logger.warn({ constraint: pg.constraint, path: req.path }, 'unique violation');
    res.status(409).json({
      error: { code: 'ALREADY_EXISTS', message: 'That already exists.' },
    });
    return;
  }

  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side' },
  });
}

export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` },
  });
}
