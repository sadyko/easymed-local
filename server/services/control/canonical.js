// LICENCE_CORE_V1 — the exact bytes a licence signature covers.
//
// A signature is over bytes, not over an object. If the vendor's signer and the
// clinic's verifier disagree about key order by even one character, every licence
// fails to verify and the error says nothing useful. So serialisation is pinned
// here, in one file, used by both sides, with its own tests.
//
// JSON.stringify's array-replacer form was rejected: it filters keys recursively
// in ways that are easy to get subtly wrong. This is explicit instead.
//
// This builds the JSON text itself rather than sorting keys onto a plain object
// and handing that to JSON.stringify. That first approach looked right and even
// passed the basic key-order tests, but it does not work: the JS spec always
// enumerates array-index-like own keys ("2", "10", ...) ahead of other string
// keys, in ascending numeric order, no matter what order they were assigned in
// — so a plain object can never be made to hold an arbitrary lexicographic key
// order. A licence field keyed by something numeric-looking (a branch id used
// as an object key, say) would silently come out ahead of alphabetic keys
// instead of in sorted position, and — worse — inconsistently between two
// otherwise-identical payloads built in a different property order. Writing
// the string by hand sidesteps native key enumeration entirely.
//
// The sort itself uses the default Array.prototype.sort comparator (UTF-16 code
// unit order), never localeCompare — that comparator does not consult the OS
// locale, so the same licence sorts identically on the vendor's machine and
// every clinic install regardless of locale.

export function canonical(value) {
  return serialize(value);
}

function serialize(value) {
  if (Array.isArray(value)) {
    // undefined has no JSON form; JSON.stringify maps it to null inside arrays
    // (unlike object properties, where it is dropped) — match that here too.
    return '[' + value.map((item) => (item === undefined ? 'null' : serialize(item))).join(',') + ']';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);   // primitives: let JSON.stringify handle escaping/format
  }
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)   // dropped, not nulled — matches JSON.stringify on objects
    .sort();
  const entries = keys.map((key) => JSON.stringify(key) + ':' + serialize(value[key]));
  return '{' + entries.join(',') + '}';
}
