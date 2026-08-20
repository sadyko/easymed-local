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
// and handing that to JSON.stringify. The plain-object version is NOT broken —
// it is deterministic, and it produces byte-identical output for the licence
// payload this system actually signs. It was measured, not assumed.
//
// It is replaced because it cannot honour its own contract. The JS spec always
// enumerates array-index-like own keys ("2", "10", ...) ahead of other string
// keys in ascending numeric order, whatever order they were assigned in, so a
// plain object can never hold an arbitrary lexicographic key order: {"2","10"}
// comes back where {"10","2"} was asked for.
//
// That matters the day the signer is not this file. A licence is signed on the
// vendor's machine and verified on a clinic's; if the control plane is ever
// written in Python or Go, its "sort the keys" will be plain lexicographic and
// will disagree with JavaScript's enumeration on any numeric-looking key. The
// signature then fails with no useful error, on that key only, forever. Writing
// the string by hand makes the format portable — the contract is exactly
// "lexicographic by UTF-16 code unit", with nothing left to a host language's
// object semantics.
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
