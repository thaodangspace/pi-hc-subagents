/**
 * Error hierarchy for the tiny fixture service.
 *
 * Every operational failure is an AppError so callers can switch on `code`
 * instead of matching message strings.
 */
export class AppError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AppError";
    this.code = code;
  }
}

export class ConfigurationError extends AppError {
  constructor(message: string) {
    super(message, "configuration");
    this.name = "ConfigurationError";
  }
}

export class TimeoutError extends AppError {
  constructor(message: string) {
    super(message, "timeout");
    this.name = "TimeoutError";
  }
}

export class TransportError extends AppError {
  constructor(message: string) {
    super(message, "transport");
    this.name = "TransportError";
  }
}
