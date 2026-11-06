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

/**
 * Collapses letter-spaced words ("s u i c i d e", "k i l l  m y s e l f" -> "killmyself"):
 * inside a run of at least two single-letter tokens separated by single spaces, the spaces are
 * removed. The offset maps are carried over, so spans still point into the ORIGINAL text.
 * Word breaks inside such a run are lost, so matchers must use space-less pattern variants.
 */
export function collapseSpacedLetters(n: NormalizedText): NormalizedText {
  const t = n.text;
  const keep: boolean[] = new Array<boolean>(t.length).fill(true);
  let i = 0;
  while (i < t.length) {
    // A run starts at a single-letter token: letter at i, boundary before and after.
    const isTok = (j: number) =>
      LETTER.test(t[j] ?? "") && (j === 0 || t[j - 1] === " ") && (j + 1 === t.length || t[j + 1] === " ");
    if (!isTok(i)) {
      i += 1;
      continue;
    }
    const spaces: number[] = [];
    let j = i;
    let count = 1;
    // A gap wider than one original character is treated as a word break.
    const narrow = (sp: number) => (n.end[sp] ?? 0) - (n.start[sp] ?? 0) === 1;
    while (j + 2 < t.length && t[j + 1] === " " && narrow(j + 1) && isTok(j + 2)) {
      spaces.push(j + 1);
      j += 2;
      count += 1;
    }
    if (count >= 2) for (const sp of spaces) keep[sp] = false;
    i = j + 1;
  }
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let k = 0; k < t.length; k++) {
    if (!keep[k]) {
      // The removed space is covered by extending the previous unit's span.
      if (end.length > 0) end[end.length - 1] = n.end[k] ?? end[end.length - 1]!;
      continue;
    }
    chars.push(t[k] as string);
    start.push(n.start[k] as number);
    end.push(n.end[k] as number);
  }
  return { text: chars.join(""), start, end };
}
