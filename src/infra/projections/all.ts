import { patientMedListProjection } from "./patient-med-list";
import { projectionRegistry } from "./registry";
import { rxStatusProjection } from "./rx-status";

let done = false;

/** Idempotent: registers the application projections once. */
export function registerAllProjections() {
  if (!done) {
    projectionRegistry.register(patientMedListProjection).register(rxStatusProjection);
    done = true;
  }
  return projectionRegistry;
}
