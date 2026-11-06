import { HandlerRegistry } from "./worker";

/**
 * The application's handler registry. Empty on purpose until the transmit feature (F048) registers
 * pharmacy handlers here: the worker only claims message types that have a handler, so messages
 * for unregistered types stay pending and untouched.
 */
export function createDefaultRegistry(): HandlerRegistry {
  return new HandlerRegistry();
}
