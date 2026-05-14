/**
 * Tiny glob -> RegExp converter.
 * Supports: *, **, ?, character classes [..], and brace expansion {a,b,c}.
 * Paths are matched with forward slashes regardless of OS.
 */
export function globToRegex(glob) {
  // Expand braces first: a/{b,c}/d -> [a/b/d, a/c/d]
  const expanded = expandBraces(glob);
  const parts = expanded.map(globOneToRegex);
  return new RegExp(`^(?:${parts.join("|")})$`);
}

function expandBraces(glob) {
  const m = glob.match(/\{([^{}]+)\}/);
  if (!m) return [glob];
  const [full, inner] = m;
  const options = inner.split(",");
  const out = [];
  for (const opt of options) {
    const replaced = glob.slice(0, m.index) + opt + glob.slice(m.index + full.length);
    out.push(...expandBraces(replaced));
  }
  return out;
}

function globOneToRegex(glob) {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++; // consume trailing slash after **
      } else {
        // * matches one path segment, not slashes
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (c === ".") {
      re += "\\.";
      i++;
    } else if (c === "/") {
      re += "/";
      i++;
    } else if (/[\\^$+()|]/.test(c)) {
      re += "\\" + c;
      i++;
    } else if (c === "[") {
      // pass through char class as-is until ]
      const end = glob.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
        i++;
      } else {
        re += glob.slice(i, end + 1);
        i = end + 1;
      }
    } else {
      re += c;
      i++;
    }
  }
  return re;
}

export function toPosix(p) {
  return p.split("\\").join("/");
}
