import type { Sql } from "postgres";
import { createTransmitHandler } from "./transmit";
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
  }
  return registry;
}

/** Base URL for the pharmacy endpoint: PHARMACY_BASE_URL, else the given origin, else localhost. */
export function pharmacyBaseUrl(fallbackOrigin?: string): string {
  return process.env.PHARMACY_BASE_URL || fallbackOrigin || "http://localhost:3000";
}
