// Project selected JSON fields without decoding discarded text or tool payloads.
export function projectJsonMetadata(json, fields) {
  let pos = 0;
  const whitespace = () => { while (/\s/.test(json[pos] || '') && pos < json.length) pos++; };
  const stringEnd = () => {
    if (json[pos++] !== '"') throw new Error('Invalid IPC string');
    while (pos < json.length) {
      const char = json[pos++];
      if (char === '"') return;
      if (char === '\\') pos++;
    }
    throw new Error('Incomplete IPC string');
  };
  function read(selection, depth = 0) {
    if (depth > 128) throw new Error('IPC JSON too deeply nested');
    whitespace();
    const start = pos;
    const char = json[pos];
    if (char === '{' || char === '[') {
      pos++;
      const array = char === '[';
      const end = array ? ']' : '}';
      const output = selection ? (array ? [] : {}) : undefined;
      whitespace();
      while (json[pos] !== end) {
        let key;
        if (!array) {
          const keyStart = pos;
          stringEnd();
          // Keys in discarded subtrees need not be materialized either.
          if (selection) key = JSON.parse(json.slice(keyStart, pos));
          whitespace();
          if (json[pos++] !== ':') throw new Error('Invalid IPC object');
        }
        const child = selection && (array ? selection['*']
          : Object.hasOwn(selection, key) ? selection[key] : selection['*']);
        const value = read(child, depth + 1);
        if (child && output) {
          if (array) output.push(value);
          else Object.defineProperty(output, key, { value, enumerable: true, configurable: true });
        }
        whitespace();
        if (json[pos] === end) break;
        if (json[pos++] !== ',') throw new Error('Invalid IPC separator');
        whitespace();
      }
      if (json[pos++] !== end) throw new Error('Incomplete IPC JSON');
      return output;
    }
    if (char === '"') stringEnd();
    else {
      while (pos < json.length && !/[\s,\]}]/.test(json[pos])) pos++;
      if (pos === start) throw new Error('Invalid IPC value');
    }
    if (!selection) return undefined;
    if (pos - start > 4096) throw new Error('IPC metadata value too large');
    return JSON.parse(json.slice(start, pos));
  }
  const value = read(fields);
  whitespace();
  if (pos !== json.length) throw new Error('Trailing IPC JSON');
  return value;
}

