import { MockPharmacyRequestSchema, simulate } from "./simulate";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 16 * 1024;

/** Seed from the SEED env var (shared with the rest of the demo); fail back to 42. */
function currentSeed(): number {
  const n = Number(process.env.SEED ?? 42);
  return Number.isFinite(n) ? Math.trunc(n) : 42;
}

/**
 * Mock pharmacy. Accepts NewRx / RxRenewalResponse / CancelRx JSON and answers like a flaky
 * pharmacy: Status OK, retryable or fatal Error, delayed responses, duplicate RxFill, CancelRx
 * acknowledgements, occasional pharmacist escalations. Deterministic for (SEED, messageId).
 * Callers must send an Idempotency-Key header (the outbox worker passes the outbox key).
 */
export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (Buffer.byteLength(text) > MAX_BODY_BYTES) {
    return Response.json({ error: "payload_too_large" }, { status: 413 });
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = MockPharmacyRequestSchema.safeParse(json);
  if (!parsed.success) {
    return Response.json(
      {
        error: "invalid_request",
        issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      },
      { status: 400 },
    );
  }
  const seed = currentSeed();
  const sim = simulate(seed, parsed.data);
  const headers: Record<string, string> = {};
  const idem = request.headers.get("idempotency-key");
  if (idem) headers["Idempotency-Key"] = idem.slice(0, 200);
  if (sim.httpStatus === 503) headers["Retry-After"] = "5";
  return Response.json(
    {
      requestMessageId: parsed.data.messageId,
      seed,
      delayMs: sim.delayMs,
      messages: sim.messages,
    },
    { status: sim.httpStatus, headers },
  );
}
