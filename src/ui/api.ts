import {
  catalogFields,
  type CatalogField,
  type CatalogFieldErrors,
} from "@/domain";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly fields: CatalogFieldErrors = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...options.headers },
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch {
    throw new ApiError(
      "Unable to connect. Check your internet connection and try again.",
      0,
      "network_unavailable",
    );
  }
  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new ApiError(
      "The service could not complete this request. Try again shortly.",
      response.status,
      "invalid_response",
    );
  }
  if (!response.ok) {
    const fault =
      typeof result === "object" && result !== null && "error" in result
        ? result.error
        : null;
    const message =
      typeof fault === "object" && fault !== null && "message" in fault
        ? fault.message
        : null;
    const code =
      typeof fault === "object" && fault !== null && "code" in fault
        ? fault.code
        : null;
    const fields: CatalogFieldErrors = {};
    if (
      typeof fault === "object" &&
      fault !== null &&
      "fields" in fault &&
      typeof fault.fields === "object" &&
      fault.fields !== null
    ) {
      for (const field of catalogFields) {
        const value = Object.getOwnPropertyDescriptor(
          fault.fields,
          field,
        )?.value;
        if (
          typeof value === "string" &&
          value.length > 0 &&
          value.length <= 500
        )
          fields[field as CatalogField] = value;
      }
    }
    throw new ApiError(
      typeof message === "string"
        ? message
        : "The request could not be completed.",
      response.status,
      typeof code === "string" ? code : "request_failed",
      fields,
    );
  }
  return result as T;
}
export const json = (value: unknown) => JSON.stringify(value);
