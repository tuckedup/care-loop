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
  // Latin look-alikes: dotless i, script/IPA letters, small capitals.
  ı: "i",
  ɑ: "a",
  ɡ: "g",
  ɩ: "i",
  ø: "o",
  ł: "l",
  ᴀ: "a",
  ʙ: "b",
  ᴄ: "c",
  ᴅ: "d",
  ᴇ: "e",
  ꜰ: "f",
  ɢ: "g",
  ʜ: "h",
  ɪ: "i",
  ᴊ: "j",
  ᴋ: "k",
  ʟ: "l",
  ᴍ: "m",
  ɴ: "n",
  ᴏ: "o",
  ᴘ: "p",
  ʀ: "r",
  ꜱ: "s",
  ᴛ: "t",
  ᴜ: "u",
  ᴠ: "v",
  ᴡ: "w",
  ʏ: "y",
  ᴢ: "z",
  "’": "'",
  "‘": "'",
  ʼ: "'",
};

const MARK = /\p{M}/u;
const FORMAT = /\p{Cf}/u;
const SPACE = /\s/u;
/**
 * Invisible or blank "letters" that render as nothing (or as blank space) but are not
 * whitespace/format characters: Hangul fillers, Braille blank, Khmer inherent vowels, Mongolian
 * vowel separator, Tag/variation selectors and similar. Dropped like zero-width characters.
 */
/** Subset of INVISIBLE_BLANK that renders as blank space. */
const BLANK_RENDERED = /[ᅟᅠ⠀ㅤﾠ]/u;
const INVISIBLE_BLANK = /[ᅟᅠ឴឵᠋-᠏⠀ㅤﾠ︀-️\u{E0000}-\u{E01EF}]/u;

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
  /** Treat blank-rendering fillers (Hangul filler, Braille blank) as spaces instead of dropping. */
  blanksAsSpace?: boolean;
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
    if (SPACE.test(ch) || (opts.blanksAsSpace && BLANK_RENDERED.test(ch))) {
      if (chars.length > 0 && chars[chars.length - 1] === " ") {
        end[end.length - 1] = next;
      } else {
        push(" ", i, next);
      }
    } else if (MARK.test(ch) || FORMAT.test(ch) || INVISIBLE_BLANK.test(ch)) {
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

const LETTER = /^[a-z]$/;

export interface CollapsedText extends NormalizedText {
  /** Per collapsed char: true if it belongs to a collapsed run of single-letter tokens. */
  inRun: boolean[];
}

/**
 * Collapses letter-spaced words ("s u i c i d e", "k  i l l  m y s e l f", "I w a n t t o d i e")
 * into a single string. A TOKEN is one a-z letter whose neighbours are not letters (so trailing
 * punctuation and brackets are fine); a RUN is two or more tokens separated by whitespace (the
 * normaliser already folded any whitespace width into one space). The spaces inside a run are
 * removed, so word breaks inside it are lost: matchers must use boundary-less, space-less pattern
 * variants and require the match to overlap `inRun`. Offset maps are carried over, so spans still
 * point into the ORIGINAL text. Linear time.
 */
export function collapseSpacedLetters(n: NormalizedText): CollapsedText {
  const t = n.text;
  const len = t.length;
  const isLetter = (j: number) => j >= 0 && j < len && LETTER.test(t[j] as string);
  const isTok = (j: number) => isLetter(j) && !isLetter(j - 1) && !isLetter(j + 1);
  const keep: boolean[] = new Array<boolean>(len).fill(true);
  const runMask: boolean[] = new Array<boolean>(len).fill(false);
  let i = 0;
  while (i < len) {
    if (!isTok(i)) {
      i += 1;
      continue;
    }
    let j = i;
    let count = 1;
    while (j + 2 < len && t[j + 1] === " " && isTok(j + 2)) {
      keep[j + 1] = false;
      j += 2;
      count += 1;
    }
    if (count >= 2) {
      for (let k = i; k <= j; k++) runMask[k] = true;
    } else {
      // A lone token is not a run (undo nothing: no spaces were removed when count is 1).
    }
    i = j + 1;
  }
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const inRun: boolean[] = [];
  for (let k = 0; k < len; k++) {
    if (!keep[k]) {
      // The removed space is covered by extending the previous unit's span.
      if (end.length > 0) end[end.length - 1] = n.end[k] ?? (end[end.length - 1] as number);
      continue;
    }
    chars.push(t[k] as string);
    start.push(n.start[k] as number);
    end.push(n.end[k] as number);
    inRun.push(runMask[k] as boolean);
  }
  return { text: chars.join(""), start, end, inRun };
}
