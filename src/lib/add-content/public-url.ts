/**
 * Guard for every URL the server fetches on a source site's say-so: the
 * confirmed source URL, each redirect hop, and each page image (#792 review).
 * http(s) only; no localhost, `.local` or `.internal` names; no IP literal in a
 * loopback, private, link-local or CGNAT range. Hostnames are not resolved, so
 * a public name that resolves to a private address still passes.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    /\.(localhost|local|internal)\.?$/.test(host) ||
    host === ""
  ) {
    return false;
  }
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) return !isPrivateV4(v4.slice(1).map(Number));
  if (host.includes(":")) return !isPrivateV6(host);
  return true;
}

export function assertPublicHttpUrl(raw: string): void {
  if (!isPublicHttpUrl(raw)) {
    throw new Error(`Refusing to fetch a non-public URL: ${raw}`);
  }
}

function isPrivateV4([a, b]: number[]): boolean {
  if (a === undefined || b === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast and reserved
  );
}

function isPrivateV6(host: string): boolean {
  if (host === "::" || host === "::1") return true;
  // IPv4-mapped (`::ffff:10.0.0.1`, which URL writes as `::ffff:a00:1`).
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mapped) {
    const hi = parseInt(mapped[1]!, 16);
    const lo = parseInt(mapped[2]!, 16);
    return isPrivateV4([hi >> 8, hi & 255, lo >> 8, lo & 255]);
  }
  return /^(f[cd]|fe[89ab])/.test(host); // unique-local fc00::/7, link-local fe80::/10
}
