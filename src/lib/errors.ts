/**
 * Typed error hierarchy for the application.
 *
 * Every operational error extends {@link AppError}, which carries a machine
 * readable `code`, an HTTP-ish `statusCode`, and an `isOperational` flag used
 * to distinguish expected failures (bad input, upstream down) from programmer
 * bugs. Unknown/unexpected throws should be treated as non-operational.
 */
export abstract class AppError extends Error {
  abstract readonly code: string;
  readonly statusCode: number;
  readonly isOperational: boolean;
  readonly context: Record<string, unknown> | undefined;

  constructor(
    message: string,
    options: {
      statusCode?: number;
      isOperational?: boolean;
      context?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.statusCode = options.statusCode ?? 500;
    this.isOperational = options.isOperational ?? true;
    this.context = options.context;
    Error.captureStackTrace?.(this, this.constructor);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
      ...(this.context ? { context: this.context } : {}),
    };
  }
}

/** Environment / startup misconfiguration. */
export class ConfigError extends AppError {
  readonly code = 'CONFIG_ERROR';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 500, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** Invalid input / failed validation. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 400, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** A requested resource does not exist. */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 404, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** Caller is not permitted to perform the action. */
export class AuthorizationError extends AppError {
  readonly code = 'AUTHORIZATION_ERROR';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 403, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** A request conflicts with current state (e.g. already-bound identity). */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 409, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** Failure talking to an external/upstream service (MT5, Brokeret, LLM, …). */
export class ExternalServiceError extends AppError {
  readonly code = 'EXTERNAL_SERVICE_ERROR';
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, { statusCode: 502, isOperational: true, ...(context ? { context } : {}) });
  }
}

/** A method/feature that is intentionally not yet implemented. */
export class NotImplementedError extends AppError {
  readonly code = 'NOT_IMPLEMENTED';
  constructor(feature: string) {
    super(`Not implemented: ${feature}`, { statusCode: 501, isOperational: true });
  }
}

/** Narrow an unknown thrown value to {@link AppError}. */
export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

/** True when the error is a known, expected operational error. */
export function isOperationalError(err: unknown): boolean {
  return isAppError(err) && err.isOperational;
}
