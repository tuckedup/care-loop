import type { Sql } from "postgres";
import {
  createCancelDeadLetterHook,
  createCancelHandler,
  createTransmitDeadLetterHook,
  createTransmitHandler,
} from "./transmit";
import { HandlerRegistry } from "./worker";

export interface RegistryDeps {
  sql: Sql;
  /** Origin that serves /api/mock-pharmacy (the app itself by default). */
  baseUrl: string;
  fetch?: typeof fetch;
}

/**
 * The application's handler registry. Without deps it is empty (the worker only claims message
 * types that have a handler, so unregistered messages stay pending and untouched). With deps it
 * registers the pharmacy transmit handler (F048).
 */
export function createDefaultRegistry(deps?: RegistryDeps): HandlerRegistry {
  const registry = new HandlerRegistry();
  if (deps) {
    registry.register("pharmacy.RxRenewalResponse", createTransmitHandler(deps));
    registry.register("pharmacy.CancelRx", createCancelHandler(deps));
    registry.registerDeadLetter("pharmacy.CancelRx", createCancelDeadLetterHook(deps.sql));
    registry.registerDeadLetter(
      "pharmacy.RxRenewalResponse",
      createTransmitDeadLetterHook(deps.sql),
    );
  }
  return registry;
}

/** Resolve a trusted pharmacy endpoint; never derive it from a request Host header in production. */
export function pharmacyBaseUrl(fallbackOrigin?: string): string {
  const configured = process.env.PHARMACY_BASE_URL;
  const raw =
    configured ||
    (process.env.NODE_ENV === "production" ? "" : fallbackOrigin || "http://localhost:3000");
  if (!raw) throw new Error("PHARMACY_BASE_URL must be configured in production");

  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error("PHARMACY_BASE_URL must be an absolute URL");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error("PHARMACY_BASE_URL must not contain credentials, query, or fragment");
  }
  if (
    endpoint.protocol !== "https:" &&
    !(process.env.NODE_ENV !== "production" && endpoint.protocol === "http:")
  ) {
    throw new Error("PHARMACY_BASE_URL must use HTTPS in production");
  }
  return endpoint.toString().replace(/\/$/, "");
}
