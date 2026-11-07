import { auditViewProjection } from "./audit-view";
import { patientMedListProjection } from "./patient-med-list";
import { pharmacyAlertsProjection } from "./pharmacy-alerts";
import { phq9TrendProjection } from "./phq9-trend";
import { projectionRegistry } from "./registry";
import { renewalMetricsProjection } from "./renewal-metrics";
import { renewalQueueProjection } from "./renewal-queue";
import { rxStatusProjection } from "./rx-status";
import { visitScheduleProjection } from "./visit-schedule";

let done = false;

/** Idempotent: registers the application projections once. */
export function registerAllProjections() {
  if (!done) {
    projectionRegistry
      .register(patientMedListProjection)
      .register(rxStatusProjection)
      .register(renewalQueueProjection)
      .register(phq9TrendProjection)
      .register(pharmacyAlertsProjection)
      .register(visitScheduleProjection)
      .register(auditViewProjection)
      .register(renewalMetricsProjection);
    done = true;
  }
  return projectionRegistry;
}
