// F055: audit coverage architecture test.
//
// Static half (TypeScript AST over every non-test source file):
//   1. Every function that takes an AuditContext is discovered (not hand-listed); none may make it
//      optional, so a caller cannot omit it.
//   2. Every call site of those functions (appendToStream, auditedTransaction, handleCommand,
//      the domain handlers, ...) must pass a real context: an object literal with actor, role and
//      action, a forwarded AuditContext parameter, or a helper that returns one. No `undefined`,
//      no `{}`, no `as` casts. A user-role context may not hard-code the actor.
//   3. The set of files that write through appendToStream / auditedTransaction directly is pinned,
//      so a NEW writer fails this test until it is reviewed and added.
//   4. Every entry point under src/app that reaches a writer (server action, route handler, page)
//      also calls an auth guard (session role check or the cron bearer check).
//   5. Events and audit_log rows are only written by the audit-log / event-store modules, and no
//      no-op / fake auditor exists in shipped code.
// Runtime half: a scenario spanning patient, clinician, decision pipeline (system) and outbox
// worker (system) writes; every event has an audit entry with an actor and a valid role.
import fs from "node:fs";
import { seedConfirmedRenewal } from "@/domain/visit/testing";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approveRenewal, startReview } from "@/domain/clinician/handlers";
import { evaluateRenewal } from "@/domain/pipeline/process-manager";
import { aiDepsFor, seedRenewal, spyClient } from "@/domain/pipeline/testing";
import { bookFollowUpVisit, signVisitNote, SCHEDULING_CLINICIAN_ID } from "@/domain/visit/handlers";
import { generateSlots } from "@/domain/visit/slots";
import { insertOutboxInTx } from "@/infra/outbox/enqueue";
import { HandlerRegistry, runOnce, DEFAULT_WORKER_CONFIG } from "@/infra/outbox/worker";
import { createTestDb, type TestDb } from "@/test/db";
import { AUDIT_ROLES } from "./audit-log";

const ROOT = process.cwd();
const USER_ROLES = ["patient", "clinician", "pharmacist", "admin"];
const GUARDS = new Set(["requireRole", "requirePatient", "requirePageRole", "isCronAuthorized"]);
/** Files that call appendToStream / auditedTransaction themselves (reviewed; pinned). */
const DIRECT_WRITERS = [
  "scripts/db-seed-lib.ts",
  "src/domain/aggregate-handler.ts",
  "src/domain/pharmacy-queue.ts",
  "src/domain/renewal/exclusive-request.ts",
  "src/domain/renewal/pharmacy-responses.ts",
  "src/domain/visit/handlers.ts",
  "src/infra/outbox/append.ts",
  "src/infra/outbox/stalled.ts",
  "src/infra/outbox/test-fixture.ts",
  "src/infra/outbox/transmit.ts",
  "src/infra/outbox/worker.ts",
];

interface Source {
  file: string;
  text: string;
  sf: ts.SourceFile;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".next") || e.name === "test") continue;
      walk(rel, out);
    } else if (
      /\.tsx?$/.test(e.name) &&
      !/\.test\.tsx?$/.test(e.name) &&
      !e.name.endsWith(".d.ts")
    ) {
      out.push(rel);
    }
  }
  return out;
}

const sources: Source[] = [...walk("src"), ...walk("scripts")].map((file) => {
  const text = fs.readFileSync(path.join(ROOT, file), "utf8");
  return { file, text, sf: ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true) };
});

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction;
const isFnLike = (n: ts.Node): n is FnLike =>
  ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n);

function fnName(fn: FnLike): string | undefined {
  if (fn.name) return fn.name.text;
  if (ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name)) {
    return fn.parent.name.text;
  }
  return undefined;
}

function visit(sf: ts.SourceFile, cb: (n: ts.Node) => void) {
  const v = (n: ts.Node) => {
    cb(n);
    ts.forEachChild(n, v);
  };
  v(sf);
}

// ---- discovery ------------------------------------------------------------------------------

interface CtxTaker {
  file: string;
  index: number;
  optional: boolean;
}
const ctxTakers = new Map<string, CtxTaker>();
for (const s of sources) {
  visit(s.sf, (n) => {
    if (!isFnLike(n)) return;
    const name = fnName(n);
    if (!name) return;
    n.parameters.forEach((p, index) => {
      const t = p.type?.getText(s.sf) ?? "";
      if (/\bAuditContext\b/.test(t)) {
        ctxTakers.set(name, {
          file: s.file,
          index,
          optional: !!p.questionToken || !!p.initializer || /undefined|null/.test(t),
        });
      }
    });
  });
}
// writeEntry is an internal helper fed by auditedTransaction after Zod validation.
ctxTakers.delete("writeEntry");

// ---- classification -------------------------------------------------------------------------

function keysOf(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile) {
  const keys = new Set<string>();
  const spreads: ts.Expression[] = [];
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) spreads.push(p.expression);
    else if (p.name) keys.add(p.name.getText(sf));
  }
  return { keys, spreads };
}

function stripConst(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (
      ts.isAsExpression(cur) &&
      ts.isTypeReferenceNode(cur.type) &&
      cur.type.typeName.getText() === "const"
    ) {
      cur = cur.expression;
    } else if (ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

/** A context expression is acceptable; returns an explanation when it is not. */
function checkCtx(expr: ts.Expression | undefined, at: ts.Node, s: Source): string | null {
  if (!expr) return "audit context argument is missing";
  const e = stripConst(expr);
  if (ts.isAsExpression(e) || ts.isTypeAssertionExpression(e)) return "context is type-cast";
  if (e.kind === ts.SyntaxKind.UndefinedKeyword || e.kind === ts.SyntaxKind.NullKeyword) {
    return "context is null/undefined";
  }
  if (ts.isIdentifier(e) && e.text === "undefined") return "context is undefined";
  if (ts.isObjectLiteralExpression(e)) return checkLiteral(e, at, s);
  if (ts.isIdentifier(e)) return checkIdentifier(e.text, at, s);
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const decl = findFunction(e.expression.text, at, s);
    if (decl && returnsCtx(decl, s)) return null;
    return `context helper ${e.expression.text}() does not provably return an AuditContext`;
  }
  return `unsupported context expression: ${e.getText(s.sf).slice(0, 60)}`;
}

function checkLiteral(obj: ts.ObjectLiteralExpression, at: ts.Node, s: Source): string | null {
  const { keys, spreads } = keysOf(obj, s.sf);
  let forwarded = false;
  for (const sp of spreads) {
    if (ts.isIdentifier(sp) && checkIdentifier(sp.text, at, s) === null) forwarded = true;
    else return "context spreads something that is not a known AuditContext";
  }
  const missing = ["actor", "role", "action"].filter((k) => !keys.has(k) && !forwarded);
  if (missing.length > 0) return `context lacks ${missing.join(", ")}`;
  const prop = (k: string) =>
    obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name.getText(s.sf) === k) as
      ts.PropertyAssignment | undefined;
  const role = prop("role");
  const actor = prop("actor");
  if (role && ts.isStringLiteral(stripConst(role.initializer))) {
    const r = (stripConst(role.initializer) as ts.StringLiteral).text;
    if (!(AUDIT_ROLES as readonly string[]).includes(r)) return `unknown audit role "${r}"`;
    if (USER_ROLES.includes(r) && actor && ts.isStringLiteral(stripConst(actor.initializer))) {
      return `user role "${r}" with a hard-coded actor (must come from the session)`;
    }
  }
  return null;
}

function scopes(at: ts.Node): ts.Node[] {
  const out: ts.Node[] = [];
  for (let n: ts.Node | undefined = at; n; n = n.parent) out.push(n);
  return out;
}

function checkIdentifier(name: string, at: ts.Node, s: Source): string | null {
  for (const scope of scopes(at)) {
    if (isFnLike(scope)) {
      const p = scope.parameters.find((x) => x.name.getText(s.sf) === name);
      if (p) {
        return p.type && /\bAuditContext\b/.test(p.type.getText(s.sf)) && !p.questionToken
          ? null
          : `parameter "${name}" is not typed AuditContext`;
      }
    }
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const st of scope.statements) {
        if (!ts.isVariableStatement(st)) continue;
        for (const d of st.declarationList.declarations) {
          if (d.name.getText(s.sf) !== name || !d.initializer) continue;
          return checkCtx(d.initializer, d, s);
        }
      }
    }
  }
  return `cannot resolve "${name}" to an AuditContext`;
}

function findFunction(name: string, at: ts.Node, s: Source): FnLike | undefined {
  for (const scope of scopes(at)) {
    if (ts.isBlock(scope) || ts.isSourceFile(scope)) {
      for (const st of scope.statements) {
        if (ts.isFunctionDeclaration(st) && st.name?.text === name) return st;
        if (ts.isVariableStatement(st)) {
          for (const d of st.declarationList.declarations) {
            if (d.name.getText(s.sf) === name && d.initializer && isFnLike(d.initializer)) {
              return d.initializer;
            }
          }
        }
      }
    }
  }
  return undefined;
}

function returnsCtx(fn: FnLike, s: Source): boolean {
  if (fn.type && /\bAuditContext\b/.test(fn.type.getText(s.sf))) return true;
  const body = fn.body;
  if (!body) return false;
  const okLiteral = (e: ts.Expression) => {
    const x = stripConst(e);
    return ts.isObjectLiteralExpression(x) && checkLiteral(x, fn, s) === null;
  };
  if (!ts.isBlock(body)) return okLiteral(body);
  let ok = false;
  visit(body.getSourceFile(), () => undefined);
  const walkBody = (n: ts.Node) => {
    if (ts.isReturnStatement(n) && n.expression && okLiteral(n.expression)) ok = true;
    ts.forEachChild(n, walkBody);
  };
  walkBody(body);
  return ok;
}

interface Site {
  file: string;
  line: number;
  callee: string;
  problem: string | null;
}
const sites: Site[] = [];
for (const s of sources) {
  visit(s.sf, (n) => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
    const taker = ctxTakers.get(n.expression.text);
    if (!taker) return;
    // The definitions and their direct recursion/forwarding inside audit-log.ts are exercised by
    // the checks below like any other site.
    const { line } = s.sf.getLineAndCharacterOfPosition(n.getStart(s.sf));
    sites.push({
      file: s.file,
      line: line + 1,
      callee: n.expression.text,
      problem: checkCtx(n.arguments[taker.index], n, s),
    });
  });
}

// ---- tests (static) -------------------------------------------------------------------------

describe("audit coverage: static architecture", () => {
  it("discovers the real write path (guards against a vacuous scan)", () => {
    for (const name of [
      "appendToStream",
      "auditedTransaction",
      "handleCommand",
      "handleCommandWithOutbox",
      "registerPatient",
      "requestRenewal",
      "submitCheckIn",
      "consumePharmacyResponse",
    ]) {
      expect(ctxTakers.has(name), `${name} should take an AuditContext`).toBe(true);
    }
    expect(sites.length).toBeGreaterThan(25);
  });

  it("no function makes its AuditContext optional", () => {
    const optional = [...ctxTakers]
      .filter(([, t]) => t.optional)
      .map(([n, t]) => `${t.file}: ${n}`);
    expect(optional).toEqual([]);
  });

  it("every call site passes a real audit context with actor and role", () => {
    const bad = sites
      .filter((x) => x.problem)
      .map((x) => `${x.file}:${x.line} ${x.callee}(): ${x.problem}`);
    expect(bad).toEqual([]);
  });

  it("the files that write through appendToStream / auditedTransaction directly are pinned", () => {
    const direct = new Set(
      sites
        .filter(
          (x) =>
            (x.callee === "appendToStream" || x.callee === "auditedTransaction") &&
            x.file !== "src/infra/audit/audit-log.ts",
        )
        .map((x) => x.file),
    );
    expect([...direct].sort()).toEqual([...DIRECT_WRITERS].sort());
  });

  it("every app entry point that reaches a writer also calls an auth guard", () => {
    // Transitive closure of functions that (by name) reach a context-taking writer.
    const reach = new Set(ctxTakers.keys());
    for (let changed = true; changed;) {
      changed = false;
      for (const s of sources) {
        visit(s.sf, (n) => {
          if (!isFnLike(n)) return;
          const name = fnName(n);
          if (!name || reach.has(name) || !n.body) return;
          let hits = false;
          const find = (m: ts.Node) => {
            if (
              ts.isCallExpression(m) &&
              ts.isIdentifier(m.expression) &&
              reach.has(m.expression.text)
            ) {
              hits = true;
            }
            if (!hits) ts.forEachChild(m, find);
          };
          find(n.body);
          if (hits) {
            reach.add(name);
            changed = true;
          }
        });
      }
    }
    const unguarded: string[] = [];
    let entryPoints = 0;
    const appFiles = sources.filter((x) => x.file.startsWith("src/app/"));
    const isServerAction = (s: Source) => /^\s*["']use server["']/m.test(s.text.slice(0, 400));
    // A call to another file's server action is guarded in that file (and checked there).
    const actionNames = new Set<string>();
    for (const s of appFiles.filter(isServerAction)) {
      visit(s.sf, (n) => {
        if (isFnLike(n) && fnName(n)) actionNames.add(fnName(n)!);
      });
    }
    // Entry points: server actions, route handlers, pages. (_lib services and client components
    // are reached through entry points, which are what must guard.)
    for (const s of appFiles.filter(
      (x) => isServerAction(x) || /\/(route|page)\.tsx?$/.test(x.file),
    )) {
      let writes = false;
      let guarded = false;
      const declared = new Set<string>();
      visit(s.sf, (n) => {
        if (isFnLike(n) && fnName(n)) declared.add(fnName(n)!);
      });
      visit(s.sf, (n) => {
        if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return;
        const callee = n.expression.text;
        if (reach.has(callee) && !(actionNames.has(callee) && !declared.has(callee))) writes = true;
        if (GUARDS.has(callee)) guarded = true;
      });
      if (writes) {
        entryPoints++;
        if (!guarded) unguarded.push(s.file);
      }
    }
    expect(entryPoints).toBeGreaterThan(5);
    expect(unguarded).toEqual([]);
  });

  it("events and audit_log are written only by the audit-log / event-store modules", () => {
    const offenders: string[] = [];
    for (const s of sources) {
      const code = s.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      if (
        /INSERT\s+INTO\s+"?events"?\b/i.test(code) &&
        s.file !== "src/infra/event-store/store.ts"
      ) {
        offenders.push(`${s.file}: INSERT INTO events`);
      }
      if (/\b(UPDATE|DELETE\s+FROM)\s+"?events"?\b/i.test(code))
        offenders.push(`${s.file}: mutates events`);
      if (
        /INSERT\s+INTO\s+"?audit_log"?\b/i.test(code) &&
        s.file !== "src/infra/audit/audit-log.ts"
      ) {
        offenders.push(`${s.file}: INSERT INTO audit_log`);
      }
      if (/\b(UPDATE|DELETE\s+FROM)\s+"?audit_log"?\b/i.test(code)) {
        offenders.push(`${s.file}: mutates audit_log`);
      }
      if (
        /\binsertEventsInTx\s*\(/.test(code) &&
        !["src/infra/event-store/store.ts", "src/infra/audit/audit-log.ts"].includes(s.file)
      ) {
        offenders.push(`${s.file}: calls insertEventsInTx directly`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("there is no no-op / fake auditor in shipped code", () => {
    const re = /no-?op.{0,24}audit|audit.{0,24}no-?op|\b(Null|Dummy|Fake|Stub|Mock)Audit/i;
    const hits = sources
      .filter((s) => re.test(s.text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")))
      .map((s) => s.file);
    expect(hits).toEqual([]);
  });

  it("the scanner itself catches an omitted or fake context (self-test)", () => {
    const probe = (code: string) => {
      const text = `import { appendToStream } from "x";\nasync function f(sql: S, ctx: AuditContext) {\n${code}\n}`;
      const s: Source = {
        file: "probe.ts",
        text,
        sf: ts.createSourceFile("probe.ts", text, ts.ScriptTarget.Latest, true),
      };
      let problem: string | null = "no call found";
      visit(s.sf, (n) => {
        if (
          ts.isCallExpression(n) &&
          ts.isIdentifier(n.expression) &&
          n.expression.text === "appendToStream"
        ) {
          problem = checkCtx(n.arguments[4], n, s);
        }
      });
      return problem;
    };
    expect(probe(`await appendToStream(sql, "s", 0, [], ctx);`)).toBeNull();
    expect(
      probe(`await appendToStream(sql, "s", 0, [], { actor: "w", role: "system", action: "a" });`),
    ).toBeNull();
    expect(probe(`await appendToStream(sql, "s", 0, []);`)).toMatch(/missing/);
    expect(probe(`await appendToStream(sql, "s", 0, [], undefined);`)).toMatch(/undefined/);
    expect(probe(`await appendToStream(sql, "s", 0, [], {} as never);`)).toMatch(/cast/);
    expect(probe(`await appendToStream(sql, "s", 0, [], { actor: "a", action: "x" });`)).toMatch(
      /lacks role/,
    );
    expect(
      probe(
        `await appendToStream(sql, "s", 0, [], { actor: "bob", role: "clinician", action: "x" });`,
      ),
    ).toMatch(/hard-coded actor/);
    expect(probe(`await appendToStream(sql, "s", 0, [], other);`)).toMatch(/cannot resolve/);
  });
});

// ---- tests (runtime) ------------------------------------------------------------------------

describe("audit coverage: every event written by a real scenario has an audit entry", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await createTestDb();
  }, 60_000);
  afterAll(async () => {
    await db.drop();
  });

  it("covers patient, clinician and system (pipeline, worker) actors", async () => {
    const NOW = new Date("2026-11-06T12:00:00Z");
    const clinician = { role: "clinician" as const, id: SCHEDULING_CLINICIAN_ID };
    // patient + admin seeding, then the system decision pipeline
    const a = await seedConfirmedRenewal(db.sql);
    await evaluateRenewal(db.sql, a.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
      refillLimit: 5,
    });
    // clinician review + approval
    await startReview(db.sql, clinician, { renewalId: a.renewalId });
    await approveRenewal(db.sql, clinician, { renewalId: a.renewalId });
    // patient books, clinician signs (visit stream + task stream)
    const b = await seedRenewal(db.sql);
    await evaluateRenewal(db.sql, b.renewalId, {
      ai: aiDepsFor(spyClient()),
      now: () => NOW,
      refillLimit: 0,
    });
    const slot = generateSlots(NOW)[2]!;
    await bookFollowUpVisit(
      db.sql,
      { role: "patient", id: b.patientId },
      { renewalId: b.renewalId, ...slot },
      NOW,
    );
    await signVisitNote(
      db.sql,
      clinician,
      { visitId: `fu-${b.renewalId}`, noteId: "note-cov" },
      new Date("2027-01-15T12:00:00Z"),
    );
    // outbox worker (system actor)
    await db.sql.begin(async (tx) => {
      await insertOutboxInTx(tx, [
        {
          type: "pharmacy.NewRx",
          idempotencyKey: "cov-1",
          payload: {
            renewalId: "rc",
            prescriptionId: "rx",
            pharmacyId: "1234567",
            messageId: "mc",
          },
        },
      ]);
    });
    await runOnce(db.sql, {
      registry: new HandlerRegistry().register("pharmacy.NewRx", async () => undefined),
      rng: () => 0.5,
      config: DEFAULT_WORKER_CONFIG,
      now: () => new Date(Date.now() + 120_000),
    });

    // 1. No event exists without an audit entry that names its global position.
    const orphans = await db.sql.unsafe<{ global_position: string; type: string }[]>(
      `SELECT e.global_position, e.type FROM events e
        WHERE NOT EXISTS (
          SELECT 1 FROM audit_log a
           WHERE a.detail->'events' @> jsonb_build_array(
                   jsonb_build_object('globalPosition', e.global_position::text)))`,
    );
    expect(orphans).toEqual([]);

    // 2. Every audit entry has a non-empty actor and a valid role.
    const rows = await db.sql.unsafe<{ actor: string; role: string; action: string }[]>(
      `SELECT actor, role, action FROM audit_log`,
    );
    expect(rows.length).toBeGreaterThan(12);
    for (const r of rows) {
      expect(r.actor.trim().length).toBeGreaterThan(0);
      expect(AUDIT_ROLES as readonly string[]).toContain(r.role);
      expect(r.action.trim().length).toBeGreaterThan(0);
    }

    // 3. The scenario really exercised each actor kind; system actors are captured too.
    const byRole = new Set(rows.map((r) => r.role));
    for (const role of ["patient", "clinician", "system", "admin"])
      expect(byRole.has(role)).toBe(true);
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("system:RecordEvaluation"); // decision pipeline
    expect(actions.some((x) => x.startsWith("outbox."))).toBe(true); // worker
    expect(rows.find((r) => r.action === "system:RecordEvaluation")).toMatchObject({
      actor: "system:decision-pipeline",
      role: "system",
    });
    expect(rows.find((r) => r.action.startsWith("outbox."))).toMatchObject({
      actor: "outbox-worker",
      role: "system",
    });
    expect(rows.find((r) => r.action === "clinician:SignVisitNote")).toMatchObject({
      actor: SCHEDULING_CLINICIAN_ID,
      role: "clinician",
    });
  });
});
