// 音高変換とキー計算（docs/design.md 4.1・4.4）
// 閲覧ページと管理画面で共用する。

// 段：lowlow=−1, low=0, mid1=1, mid2=2, hi=3, hihi=4
const TIERS = ["lowlow", "low", "mid1", "mid2", "hi", "hihi"];
const TIER_BASE = -1;
// 音名：A=0, A#=1, B=2, C=3 … G#=11
const NAMES = ["A", "A#", "B", "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#"];

export const MIN_MIDI = 21; // lowlowA
export const MAX_MIDI = 92; // hihiG#

// 長い段名を先に試す（lowlow を low、hihi を hi と読まないため）
const NOTE_PATTERN = /^(lowlow|low|mid1|mid2|hihi|hi)([a-g]#?)$/;

/** "hiA" などの文字列を MIDI 番号にする。読み取れない入力はエラー。 */
export function noteToMidi(text) {
  if (typeof text !== "string") {
    throw new TypeError(`音高を読み取れません: ${JSON.stringify(text)}`);
  }
  const normalized = text
    .normalize("NFKC") // 全角英数字・＃・全角空白を半角に
    .replace(/♯/g, "#")
    .replace(/\s/g, "")
    .toLowerCase();
  const match = NOTE_PATTERN.exec(normalized);
  const nameIndex = match ? NAMES.indexOf(match[2].toUpperCase()) : -1;
  if (nameIndex < 0) {
    throw new Error(`音高を読み取れません: ${JSON.stringify(text)}`);
  }
  const tier = TIERS.indexOf(match[1]) + TIER_BASE;
  return 33 + tier * 12 + nameIndex;
}

/** MIDI 番号を "hiA" などの文字列にする。範囲外・整数でない値はエラー。 */
export function midiToNote(midi) {
  if (!Number.isInteger(midi) || midi < MIN_MIDI || midi > MAX_MIDI) {
    throw new RangeError(`音高の範囲外です（${MIN_MIDI}〜${MAX_MIDI}）: ${JSON.stringify(midi)}`);
  }
  const offset = midi - 33;
  const tier = Math.floor(offset / 12);
  const nameIndex = offset - tier * 12;
  return TIERS[tier - TIER_BASE] + NAMES[nameIndex];
}

/**
 * 原曲に対するキーを求める（4.4 最高音優先）。
 * voice・song・settings はエクスポート形式（4.8）と同じ項目名で受け取る。
 * min_note などの将来用の項目も渡してよい（現時点では使わない）。
 * @returns {{ key: number|null, octaveDown: boolean, overridden: boolean }}
 *   key が null なら計算不能（画面では「?」と表示する）
 */
export function calcKey(voice, song, settings) {
  // 1. キー指定があればそれを最終キーとする（微調整は無視）
  if (song.key_override != null) {
    return { key: song.key_override, octaveDown: false, overridden: true };
  }
  // 2. 曲または自分の最高音が空なら計算不能
  if (song.max_note == null || voice.max_note == null) {
    return { key: null, octaveDown: false, overridden: false };
  }
  // 3. 自分の最高音との差で決める
  const { key_range: keyRange, raise_if_room: raiseIfRoom } = settings;
  const d = voice.max_note - song.max_note;
  let base;
  let octaveDown = false;
  if (d >= 0) {
    base = raiseIfRoom ? Math.min(d, keyRange) : 0;
  } else if (d >= -keyRange) {
    base = d;
  } else {
    base = d + 12;
    octaveDown = true;
  }
  // 4. 微調整を加える
  return { key: base + (song.key_adjust ?? 0), octaveDown, overridden: false };
}
