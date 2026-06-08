// src/lib/chunker.js
// Turns a stream of text tokens into a stream of complete "bubbles" (sentences).
// This is what gives the AI its texting rhythm: instead of one big block, the
// speaker's reply arrives as several sentence-sized messages.
//
// Rules:
//  - Flush a bubble when we hit sentence-ending punctuation (. ! ?) followed by
//    a space or end of input.
//  - Also flush on a newline (people break texts on newlines too).
//  - Guard against a runaway sentence: if the buffer gets very long without
//    punctuation, flush anyway so it still streams.

const MAX_BUFFER = 240; // characters before a forced flush

// Given an async iterable of text tokens, yield complete sentence strings.
export async function* chunkIntoSentences(tokenStream) {
  let buffer = '';

  for await (const token of tokenStream) {
    buffer += token;

    // Try to extract as many complete sentences as are currently in the buffer.
    let flushed;
    do {
      flushed = false;
      const boundary = findSentenceBoundary(buffer);
      if (boundary !== -1) {
        const sentence = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary);
        if (sentence) {
          yield sentence;
          flushed = true;
        }
      } else if (buffer.length >= MAX_BUFFER) {
        // Forced flush on a very long run with no punctuation.
        const sentence = buffer.trim();
        buffer = '';
        if (sentence) {
          yield sentence;
        }
      }
    } while (flushed);
  }

  // Flush whatever's left at the end.
  const tail = buffer.trim();
  if (tail) yield tail;
}

// Return the index just past the end of the first complete sentence in `s`,
// or -1 if there isn't one yet. A sentence ends at a run of . ! ? (e.g. ".",
// "!!", "...") FOLLOWED BY WHITESPACE, or at a newline. End-of-buffer is NOT a
// boundary here: while streaming, more characters (more punctuation, or the
// rest of a number like "3.50") may still be coming. The final leftover is
// flushed by the caller when the stream ends.
function findSentenceBoundary(s) {
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\n') {
      return i + 1;
    }
    if (c === '.' || c === '!' || c === '?') {
      let j = i;
      while (j + 1 < s.length && '.!?'.includes(s[j + 1])) j++;
      const next = s[j + 1];
      // Only a boundary if we can SEE whitespace after the punctuation run.
      if (next === ' ' || next === '\n') {
        return j + 1;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return -1;
}
