// Text normalisation with an offset map, so matches found on normalised text can be reported as
// exact [start,end) spans of the ORIGINAL text. Single linear pass.
//   - NFKD, combining marks dropped, lower-cased
//   - a small set of Cyrillic/Greek look-alikes mapped to Latin
//   - typographic apostrophes folded to "'"
//   - zero-width / format characters dropped
//   - runs of whitespace collapsed to one space

export interface NormalizedText {
  text: string;
  /** For normalised char i: original [start[i], end[i]) (UTF-16 offsets). */
  start: number[];
  end: number[];
}

// Look-alikes (not exhaustive).
const CONFUSABLES: Readonly<Record<string, string>> = {
  а: "a", // Cyrillic a
  е: "e",
  о: "o",
  р: "p",
  с: "c",
  х: "x",
  у: "y",
  і: "i",
  ј: "j",
  ѕ: "s",
  һ: "h",
  ԁ: "d",
  ο: "o", // Greek omicron
  α: "a",
  ι: "i",
  ν: "v",
  κ: "k",
  и: "u",
  к: "k",
  т: "t",
  м: "m",
  н: "h",
  в: "b",
  ε: "e",
  τ: "t",
  υ: "u",
  ρ: "p",
  "’": "'",
  "‘": "'",
  ʼ: "'",
};

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;

/** Digit/symbol look-alikes ("k1ll", "su1cide"). Only used when `leet` is requested. */
const LEET: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
};

export interface NormalizeOptions {
  /** Also fold digit/symbol look-alikes to letters. Over-inclusive by design. */
  leet?: boolean;
}

/**
 * INVARIANT: text.length === start.length === end.length. The maps are indexed per UTF-16 code
 * unit of the NORMALISED text (never per code point), so an astral character cannot shift them.
 */
export function normalizeWithMap(input: string, opts: NormalizeOptions = {}): NormalizedText {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const push = (unitText: string, from: number, to: number) => {
    for (let k = 0; k < unitText.length; k++) {
      chars.push(unitText[k] as string);
      start.push(from);
      end.push(to);
    }
  };
  for (let i = 0; i < input.length;) {
    const cp = input.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (SPACE.test(ch)) {
      if (chars.length > 0 && chars[chars.length - 1] === " ") {
        end[end.length - 1] = next;
      } else {
        push(" ", i, next);
      }
    } else if (MARK.test(ch) || FORMAT.test(ch)) {
      if (end.length > 0) {
        // Extend the span of the preceding normalised unit(s) of the previous character.
        end[end.length - 1] = next;
      }
    } else {
      for (const d of ch.normalize("NFKD")) {
        if (MARK.test(d)) continue;
        for (const c of d.toLowerCase()) {
          let m = CONFUSABLES[c] ?? c;
          if (opts.leet) m = LEET[m] ?? m;
          push(m, i, next);
        }
      }
    }
    i = next;
  }
  return { text: chars.join(""), start, end };
}
