// Pure, seeded simulation of a pharmacy endpoint. Deterministic: the same (seed, request) always
// produces the same outcome, so replays with the same message id are consistent and tests are
// stable. Message names follow the SCRIPT-style vocabulary in docs/SPEC.md section 7
// (NewRx, RxRenewalResponse, Status, Error, RxFill, CancelRx). Synthetic only; no real network.
import { z } from "zod";
import { hashString, mulberry32 } from "@/infra/outbox/rng";

const id = z.string().min(1).max(200);
const pharmacyId = z.string().regex(/^[0-9]{7}$/, "pharmacy id must be exactly 7 digits");

const Common = {
  messageId: id,
  renewalId: id,
  prescriptionId: id,
  pharmacyId,
  /** Optional 1-based delivery attempt (the outbox worker sends it); later attempts draw anew. */
  attempt: z.number().int().min(1).max(100).optional(),
};

export const MockPharmacyRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("NewRx"), ...Common }),
  z.object({
    type: z.literal("RxRenewalResponse"),
    ...Common,
    response: z.enum(["Approved", "Denied"]),
  }),
  z.object({ type: z.literal("CancelRx"), ...Common }),
]);
export type MockPharmacyRequest = z.infer<typeof MockPharmacyRequestSchema>;

export type PharmacyMessage =
  | { type: "Status"; messageId: string; status: "OK" }
  | {
      type: "Error";
      messageId: string;
      code: string;
      retryable: boolean;
      description: string;
    }
  | { type: "RxFill"; messageId: string; renewalId: string; prescriptionId: string }
  | { type: "CancelRx"; messageId: string; acknowledged: true }
  | { type: "PharmacistEscalation"; messageId: string; message: string };

export interface Simulation {
  /** HTTP status the route should answer with. */
  httpStatus: 200 | 422 | 503;
  /** Simulated processing delay the pharmacy asks the caller to honour (not slept by default). */
  delayMs: number;
  messages: PharmacyMessage[];
}

export interface SimulationRates {
  retryableError: number;
  fatalError: number;
  delayed: number;
  fill: number;
  duplicateFill: number;
  cancelAck: number;
  escalation: number;
}

export const DEFAULT_RATES: SimulationRates = {
  retryableError: 0.15,
  fatalError: 0.07,
  delayed: 0.3,
  fill: 0.6,
  duplicateFill: 0.2, // share of fills that arrive twice with the same messageId
  cancelAck: 0.05,
  escalation: 0.08,
};

const RETRYABLE_CODES = [
  ["PHARMACY_BUSY", "Pharmacy system busy, retry later"],
  ["TEMPORARY_UNAVAILABLE", "Pharmacy system temporarily unavailable"],
] as const;
const FATAL_CODES = [
  ["UNKNOWN_PRESCRIPTION", "Prescription not found at this pharmacy"],
  ["INVALID_PHARMACY", "Pharmacy cannot accept this message"],
] as const;
const ESCALATIONS = [
  "Pharmacist asks the prescriber to confirm the dose on this prescription.",
  "Pharmacist reports a possible duplicate therapy and requests a call back.",
  "Pharmacist asks whether the patient's last fill date is correct.",
];

/**
 * Scripted scenarios for end-to-end tests (MOCK_PHARMACY_FORCE). They override the random draw:
 * "retry-then-fill": attempt 1 answers a retryable error, later attempts Status OK + one RxFill.
 * "escalation": Status OK + RxFill + a pharmacist escalation on the first delivery.
 */
export type ForcedScenario = "retry-then-fill" | "escalation";

/**
 * MOCK_PHARMACY_FORCE is honoured ONLY when NODE_ENV is exactly "development" or "test"
 * (default deny: production, unset, "Production" and anything else ignore it).
 */
export function forcedScenario(env: {
  NODE_ENV?: string | undefined;
  MOCK_PHARMACY_FORCE?: string | undefined;
}): ForcedScenario | undefined {
  if (env.NODE_ENV !== "development" && env.NODE_ENV !== "test") return undefined;
  const f = env.MOCK_PHARMACY_FORCE;
  return f === "retry-then-fill" || f === "escalation" ? f : undefined;
}

export function simulate(
  seed: number,
  req: MockPharmacyRequest,
  rates: SimulationRates = DEFAULT_RATES,
  force?: ForcedScenario,
  /** The Idempotency-Key header, if any. The outcome depends on (seed, key), never on the attempt. */
  idempotencyKey?: string | null,
): Simulation {
  const attempt = req.attempt ?? 1;
  // Same key (or messageId) => same outcome, so a crash-resend gets a consistent answer.
  const rng = mulberry32((seed ^ hashString(idempotencyKey || req.messageId)) >>> 0);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)]!;
  const mid = (suffix: string) => `${req.messageId}:${suffix}`;
  // Always draw the same number of values in the same order, so rates do not shift later draws.
  const rError = rng();
  const rDelay = rng();
  const rDelayLen = rng();
  const rFill = rng();
  const rDup = rng();
  const rCancel = rng();
  const rEsc = rng();

  if (force && req.type !== "CancelRx") {
    const status: PharmacyMessage = { type: "Status", messageId: mid("status"), status: "OK" };
    const fill: PharmacyMessage = {
      type: "RxFill",
      messageId: mid("fill"),
      renewalId: req.renewalId,
      prescriptionId: req.prescriptionId,
    };
    if (force === "retry-then-fill" && attempt <= 1) {
      return {
        httpStatus: 503,
        delayMs: 0,
        messages: [
          {
            type: "Error",
            messageId: mid("error"),
            code: "PHARMACY_BUSY",
            retryable: true,
            description: "Pharmacy system busy, retry later",
          },
        ],
      };
    }
    const messages: PharmacyMessage[] = [status, fill];
    if (force === "escalation") {
      messages.push({
        type: "PharmacistEscalation",
        messageId: mid("escalation"),
        message: ESCALATIONS[0]!,
      });
    }
    return { httpStatus: 200, delayMs: 0, messages };
  }

  if (req.type === "CancelRx") {
    return {
      httpStatus: 200,
      delayMs: 0,
      messages: [
        { type: "Status", messageId: mid("status"), status: "OK" },
        { type: "CancelRx", messageId: mid("cancel"), acknowledged: true },
      ],
    };
  }

  if (rError < rates.retryableError) {
    const [code, description] = pick(RETRYABLE_CODES);
    return {
      httpStatus: 503,
      delayMs: 0,
      messages: [{ type: "Error", messageId: mid("error"), code, retryable: true, description }],
    };
  }
  if (rError < rates.retryableError + rates.fatalError) {
    const [code, description] = pick(FATAL_CODES);
    return {
      httpStatus: 422,
      delayMs: 0,
      messages: [{ type: "Error", messageId: mid("error"), code, retryable: false, description }],
    };
  }

  const messages: PharmacyMessage[] = [{ type: "Status", messageId: mid("status"), status: "OK" }];
  const approved = req.type === "NewRx" || req.response === "Approved";
  if (approved && rFill < rates.fill) {
    const fill: PharmacyMessage = {
      type: "RxFill",
      messageId: mid("fill"),
      renewalId: req.renewalId,
      prescriptionId: req.prescriptionId,
    };
    messages.push(fill);
    // A duplicate keeps the SAME messageId: consumers must dedupe on it.
    if (rDup < rates.duplicateFill) messages.push({ ...fill });
  }
  if (rCancel < rates.cancelAck) {
    messages.push({ type: "CancelRx", messageId: mid("cancel"), acknowledged: true });
  }
  if (rEsc < rates.escalation) {
    messages.push({
      type: "PharmacistEscalation",
      messageId: mid("escalation"),
      message: pick(ESCALATIONS),
    });
  }
  const delayMs = rDelay < rates.delayed ? 1_000 + Math.floor(rDelayLen * 29_000) : 0;
  return { httpStatus: 200, delayMs, messages };
}
