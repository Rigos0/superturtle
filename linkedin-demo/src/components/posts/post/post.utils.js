const URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>"]+)/i;
const TRAILING_PUNCTUATION_PATTERN = /[),.;!?]+$/;

const sanitizeCandidate = (candidate = "") => {
  return candidate.replace(TRAILING_PUNCTUATION_PATTERN, "").trim();
};

const normalizeHref = (candidate) => {
  if (!candidate) {
    return null;
  }

  if (candidate.startsWith("www.")) {
    return `https://${candidate}`;
  }

  return candidate;
};

export const getLinkPreviewFromText = (text = "") => {
  if (typeof text !== "string" || text.trim().length === 0) {
    return null;
  }

  const match = text.match(URL_PATTERN);
  if (!match) {
    return null;
  }

  const sanitizedCandidate = sanitizeCandidate(match[1]);
  const href = normalizeHref(sanitizedCandidate);

  if (!href) {
    return null;
  }

  try {
    const parsed = new URL(href);

    if (!parsed.hostname) {
      return null;
    }

    return {
      href,
      hostname: parsed.hostname.replace(/^www\./, ""),
    };
  } catch (_error) {
    return null;
  }
};
