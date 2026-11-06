// Adversarial sweep (folded in from the independent review script). Every input below must be
// non-approving EXCEPT the explicit allow-list of inputs that legitimately normalise to a clean request.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect, it } from "vitest";
import { evaluateEligibility } from "./evaluate";
import { baseInput } from "./fixtures";

const hits: string[] = [];
const LEGIT_AUTO = [
  `name:${JSON.stringify("fluoxetine​")} -> AUTO_ELIGIBLE`, // zero-width char stripped
  `name:${JSON.stringify("fluoxetíne")} -> AUTO_ELIGIBLE`, // diacritic stripped
  'name:"FLUOXETINE" -> AUTO_ELIGIBLE',
  'name:"fluoxetine 20mg tablets" -> AUTO_ELIGIBLE',
  `name:${JSON.stringify("ｆｌｕｏｘｅｔｉｎｅ")} -> AUTO_ELIGIBLE`, // NFKC fullwidth
  "fid undefined -> AUTO_ELIGIBLE",
  // ACCEPTED RISK (ADR-003 note): no upper bound on refillLimit; TODO: source needed.
  "refillLimit=1e+308 -> AUTO_ELIGIBLE",
  "refillLimit=9007199254740991 -> AUTO_ELIGIBLE",
  "refillLimit=9007199254740992 -> AUTO_ELIGIBLE",
  "prior null -> AUTO_ELIGIBLE",
  "phq9 [0,0,0,0,0,0,0,0,0] -> AUTO_ELIGIBLE",
  'ai {"status":"ok","signals":[],"approve":true} -> AUTO_ELIGIBLE', // extra field ignored
];
const T = (label: string, mk: () => any) => {
  let o: string;
  try {
    o = evaluateEligibility(mk()).outcome.type;
  } catch (e) {
    o = "THROWS:" + e;
  }
  if (o !== "ESCALATE" && o !== "REJECT" && o !== "FOLLOW_UP_REQUIRED")
    hits.push(`${label} -> ${o}`);
};
const med = (o: any) => () => {
  const b: any = baseInput();
  Object.assign(b.medication, o);
  return b;
};
const ci = (o: any) => () => {
  const b: any = baseInput();
  Object.assign(b.checkIn, o);
  return b;
};
const top = (o: any) => () => ({ ...baseInput(), ...o });

it("attack", () => {
  const names = [
    "fluoxetine alprazolam",
    "fluoxetine clonazepam",
    "fluoxetine lorazepam",
    "fluoxetine diazepam",
    "fluoxetine oxycodone",
    "fluoxetine adderall",
    "fluoxetine zolpidem",
    "fluoxetine ativan",
    "fluoxetine klonopin",
    "fluoxetine xana x",
    "fluoxetine alprazol am",
    "fluoxetine alpraz\u200Bolam",
    "fluoxetine \u0430lprazolam",
    "fluoxetine alprazol\u0430m",
    "fluoxetine alprazolem",
    "fluoxetine vyvanse",
    "fluoxetine methylphenidate",
    "fluoxetine ritalin",
    "fluoxetine tramadol",
    "fluoxetine hydroxyzine",
    "fluoxetine/alprazolam",
    "flu\u043exetine",
    "fluoxetine\u200b",
    "fluoxetíne",
    "FLUOXETINE",
    "Fluoxetine ER",
    "fluoxetine IR",
    "fluoxetine 20mg tablets",
    "ｆｌｕｏｘｅｔｉｎｅ",
    "fluoxetine\u0000alprazolam",
    "alprazolam",
    "",
    " ",
    "xanax",
    "fluoxetine xanax",
    "fluoxetine (xan\u0430x)",
  ];
  for (const n of names) T("name:" + JSON.stringify(n), med({ name: n }));
  // controlled name with allowlisted rxcui across all rxcuis
  for (const r of [
    "4493",
    "36437",
    "321988",
    "2556",
    "32937",
    "39786",
    "734064",
    "72625",
    "42347",
    "10737",
    "15996",
    "1827",
    "154987",
    "203182",
  ]) {
    for (const n of [
      "alprazolam",
      "xanax",
      "lisdexamfetamine",
      "vyvanse",
      "alprazolem",
      "clonazepam",
      "lorazepam",
      "oxycodone",
      "adderall",
    ])
      T(`rx ${r} name ${n}`, () => {
        const b: any = baseInput();
        b.medication = { ...b.medication, rxcui: r, name: n, formularyId: null };
        b.activeOrder.rxcui = r;
        return b;
      });
  }
  // formulary/controlled flags
  for (const v of [undefined, "IV", "", 0, false, "null", [], {}, NaN])
    T("sched " + String(v), med({ controlledSchedule: v }));
  for (const v of [
    ["alprazolam"],
    { toString: () => "fluoxetine" },
    "alprazolam",
    "",
    undefined,
    "__proto__",
    "constructor",
    ["fluoxetine"],
  ])
    T("fid " + JSON.stringify(v), med({ formularyId: v }));
  for (const v of [
    ["4493"],
    [4493],
    4493,
    { toString: () => "4493" },
    new String("4493"),
    "4493 ",
    "04493",
    " 4493",
    "\u200b4493",
    undefined,
    null,
    "__proto__",
  ])
    T("rxcui " + JSON.stringify(v), med({ rxcui: v }));
  for (const v of [
    ["fluoxetine"],
    { toString: () => "fluoxetine" },
    5,
    null,
    undefined,
    new String("fluoxetine"),
  ])
    T("name type " + JSON.stringify(v), med({ name: v }));
  // numerics
  for (const k of ["renewalsSinceLastVisit", "refillLimit"])
    for (const v of [
      -1,
      NaN,
      Infinity,
      -Infinity,
      "1",
      "0",
      1.5,
      null,
      undefined,
      [],
      {},
      true,
      1e308,
      Number.MAX_SAFE_INTEGER,
      2 ** 53,
    ]) {
      T(`${k}=${String(v)}`, top({ [k]: v }));
    }
  T("limit 0, renewals 0", top({ refillLimit: 0 }));
  for (const v of [-1, NaN, Infinity, "3", 28, 100, 2.5, null, undefined, [], "0", true])
    T("prior " + String(v), top({ priorPhq9Total: v }));
  // PHQ9/GAD
  const arrs: any[] = [
    [0, 0, 0, 0, 0, 0, 0, 0, -1],
    [0, 0, 0, 0, 0, 0, 0, 0, 4],
    [0, 0, 0, 0, 0, 0, 0, 0, "0"],
    [0, 0, 0, 0, 0, 0, 0, 0, 0.5],
    [0, 0, 0, 0, 0, 0, 0, 0, NaN],
    [0, 0, 0, 0, 0, 0, 0, 0, null],
    [0, 0, 0, 0, 0, 0, 0, 0, undefined],
    [0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    new Array(9),
    [, , , , , , , , 0],
    [0, 0, 0, 0, 0, 0, 0, 0, ,],
    "000000000",
    { length: 9 },
    { length: 9, every: () => true },
    [0, 0, 0, 0, 0, 0, 0, 0, -0],
    [0, 0, 0, 0, 0, 0, 0, 0, new Number(0)],
    [0, 0, 0, 0, 0, 0, 0, 3, -3],
  ];
  for (const a of arrs) {
    T("phq9 " + JSON.stringify(a), ci({ phq9: a }));
    T("gad7 " + JSON.stringify(a), ci({ gad7: a }));
  }
  // fake array subclass
  class A extends Array {}
  const sub: any = A.from([0, 0, 0, 0, 0, 0, 0, 0, 1]);
  T("phq subclass item9=1", ci({ phq9: sub }));
  const px: any = new Proxy([0, 0, 0, 0, 0, 0, 0, 0, 1], {
    get(t, k, r) {
      return k === "8" ? 0 : Reflect.get(t, k, r);
    },
  });
  T("phq proxy", ci({ phq9: px }));
  for (const k of ["pregnancy", "severeSideEffect", "maniaScreen", "requestedHuman"])
    for (const v of [
      undefined,
      null,
      "No",
      "no ",
      "NO",
      0,
      "false",
      "",
      [],
      {},
      ["no"],
      new String("no"),
      "yes",
      "unsure",
      false,
      true,
    ]) {
      if ((k === "pregnancy" && v === "no") || (k !== "pregnancy" && v === false)) continue;
      T(`${k}=${JSON.stringify(v)}`, ci({ [k]: v }));
    }
  T("checkIn missing fields", () => {
    const b: any = baseInput();
    b.checkIn = {};
    return b;
  });
  // top-level
  for (const v of [undefined, null, "true", 1, "yes", [], {}, new Boolean(true)])
    T("identity " + String(v), top({ identityVerified: v }));
  for (const v of ["none ", "NONE", undefined, null, ["none"], new String("none"), "dose"])
    T("change " + String(v), top({ requestedChange: v }));
  for (const o of [
    null,
    undefined,
    { status: "active", intent: "order" },
    { status: "active", intent: "order", rxcui: "999" },
    { status: "ACTIVE", intent: "order", rxcui: "4493" },
    { status: "active", intent: "proposal", rxcui: "4493" },
    { status: "on-hold", intent: "order", rxcui: "4493" },
  ])
    T("order " + JSON.stringify(o), top({ activeOrder: o }));
  // AI variants
  const aivs: any[] = [
    undefined,
    null,
    {},
    { status: "ok" },
    { status: "ok", signals: {} },
    { status: "ok", signals: [{ x: 1 }] },
    { status: "failed", signals: [] },
    { status: "ok ", signals: [] },
    { status: "OK", signals: [] },
    { status: "ok", signals: "[]" },
    { status: "ok", signals: [null] },
    { status: "ok", signals: new Array(1) },
    { status: "ok", signals: { length: 0 } },
    "ok",
    true,
    { status: "ok", signals: [], approve: true },
  ];
  for (const a of aivs) T("ai " + JSON.stringify(a), top({ ai: a }));
  // totality
  for (const v of [null, undefined, 0, "x", [], {}, () => 1, Symbol("s")])
    T("input " + String(v), () => v);
  T("empty medication", () => ({ ...baseInput(), medication: {} }));
  T("throwing getter", () => {
    const b: any = baseInput();
    Object.defineProperty(b.medication, "name", {
      get() {
        throw new Error("x");
      },
    });
    return b;
  });
  T("throwing getter checkIn", () => {
    const b: any = baseInput();
    Object.defineProperty(b, "checkIn", {
      get() {
        throw new Error("x");
      },
    });
    return b;
  });
  T("revoked proxy", () => {
    const r = Proxy.revocable(baseInput() as any, {});
    r.revoke();
    return r.proxy;
  });
  T("proto pollution input", () =>
    JSON.parse('{"__proto__":{"identityVerified":true},"medication":{},"checkIn":{}}'),
  );
  // stateful getter: controlled name reads clean until the end
  T("stateful name", () => {
    const b: any = baseInput();
    let n = 0;
    Object.defineProperty(b.medication, "name", {
      get() {
        return n++ < 100 ? "fluoxetine" : "alprazolam";
      },
    });
    return b;
  });
  T("stateful sched", () => {
    const b: any = baseInput();
    let n = 0;
    Object.defineProperty(b.medication, "controlledSchedule", {
      get() {
        return n++ < 100 ? null : "IV";
      },
    });
    return b;
  });
  expect(hits.sort()).toEqual([...LEGIT_AUTO].sort());
});
