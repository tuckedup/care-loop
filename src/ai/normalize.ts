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
  "’": "'",
  "‘": "'",
  ʼ: "'",
};

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;

export function normalizeWithMap(input: string): NormalizedText {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < input.length;) {
    const cp = input.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const next = i + ch.length;
    if (SPACE.test(ch)) {
      if (chars.length > 0 && chars[chars.length - 1] === " ") {
        end[end.length - 1] = next;
      } else {
        chars.push(" ");
        start.push(i);
        end.push(next);
      }
    } else if (MARK.test(ch) || FORMAT.test(ch)) {
      if (end.length > 0) end[end.length - 1] = next;
    } else {
      for (const d of ch.normalize("NFKD")) {
        if (MARK.test(d)) continue;
        const lower = d.toLowerCase();
        for (const c of lower) {
          chars.push(CONFUSABLES[c] ?? c);
          start.push(i);
          end.push(next);
        }
      }
    }
    i = next;
  }
  return { text: chars.join(""), start, end };
}
