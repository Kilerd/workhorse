export class AppError extends Error {
  public readonly code: string;

  public readonly status: number;

  public readonly details?: unknown;

  public constructor(
    status: number,
    code: string,
    message: string,
    details?: unknown
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function ensure<T>(
  value: T | undefined,
  status: number,
  code: string,
  message: string
): T {
  if (value === undefined) {
    throw new AppError(status, code, message);
  }

  return value;
}
