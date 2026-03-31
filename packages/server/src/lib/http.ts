import type { IValidation } from "typia";

import type { ApiError, ApiSuccess } from "@workhorse/contracts";

import { AppError } from "./errors.js";

export function ok<T>(data: T): ApiSuccess<T> {
  return {
    ok: true,
    data
  };
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof AppError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details:
          typeof error.details === "string" || Array.isArray(error.details)
            ? error.details
            : undefined
      }
    };
  }

  if (error instanceof Error) {
    return {
      ok: false,
      error: {
        code: "INTERNAL_ERROR",
        message: error.message
      }
    };
  }

  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: "Unknown error"
    }
  };
}

export function errorStatus(error: unknown): number {
  return error instanceof AppError ? error.status : 500;
}

export function validateOrThrow<T>(
  value: unknown,
  validator: (input: unknown) => IValidation<T>,
  message: string
): T {
  const result = validator(value);
  if (!result.success) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      message,
      result.errors.map((issue) => ({
        path: issue.path,
        expected: issue.expected,
        value: issue.value
      }))
    );
  }

  return result.data;
}
