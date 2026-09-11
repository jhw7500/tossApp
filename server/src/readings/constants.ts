export const MAX_READING_ATTEMPTS = 3;
export const QUEUE_TIMEOUT_SECONDS = 60;
export const LEASE_SECONDS = 45;
export const MAX_CANDIDATES_PER_CARD = 20;
export const MAX_CONTEXT_BYTES = 64 * 1024;
export const READING_CONTRACT_VERSION = 'reading-result.v1';
export const READING_PROMPT_VERSION = 'tarot-grounded.v1';

// ECMAScript trim whitespace, passed as data to PostgreSQL btrim for matching visibility rules.
export const SOURCE_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
