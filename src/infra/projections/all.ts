import { patientMedListProjection } from "./patient-med-list";
import { phq9TrendProjection } from "./phq9-trend";
import { projectionRegistry } from "./registry";
import { renewalQueueProjection } from "./renewal-queue";
import { rxStatusProjection } from "./rx-status";

let done = false;

/** Idempotent: registers the application projections once. */
export function registerAllProjections() {
  if (!done) {
    projectionRegistry
      .register(patientMedListProjection)
      .register(rxStatusProjection)
      .register(renewalQueueProjection)
      .register(phq9TrendProjection);
    done = true;
  }
  return projectionRegistry;
}
