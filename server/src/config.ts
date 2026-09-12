import { BlockList, isIP } from 'node:net';

export interface VersionedSubjectSecret {
  version: string;
  secret: string;
}

export interface FoundationConfig {
  environment: 'local' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  authMode: 'mock' | 'toss';
  subjectSecret: string;
  subjectSecretVersion: string;
  previousSubjectSecrets: VersionedSubjectSecret[];
  allowedOrigins: string[];
  tossCertPath?: string;
  tossKeyPath?: string;
}

type Environment = Record<string, string | undefined>;

export function readWorkerConfig(env: Environment = process.env): { databaseUrl: string; ai: AiConfig } {
  const databaseUrl = env.DATABASE_URL?.trim();
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  return { databaseUrl, ai: readAiConfig(env) };
}

function required(env: Environment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function subjectSecretVersion(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) || value.toLowerCase() === 'legacy') {
    throw new Error('subject secret version must be 1-64 letters, numbers, dots, underscores, or hyphens and cannot be legacy');
  }
  return value;
}

function previousSubjectSecrets(value: string | undefined, activeVersion: string, activeSecret: string): VersionedSubjectSecret[] {
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('previous subject secrets must be a valid JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('previous subject secrets must be a JSON object of version-to-secret entries');
  }
  const entries = Object.entries(parsed);
  if (entries.length > 8) throw new Error('previous subject secrets cannot contain more than 8 entries');
  const secrets = new Set([activeSecret]);
  return entries.map(([version, secret]) => {
    const normalizedVersion = subjectSecretVersion(version);
    if (normalizedVersion === activeVersion) throw new Error('previous subject secrets cannot reuse the active version');
    if (typeof secret !== 'string' || secret.length < 32) throw new Error('each previous subject secret must be at least 32 characters');
    if (secrets.has(secret)) throw new Error('subject secrets must be distinct across versions');
    secrets.add(secret);
    return { version: normalizedVersion, secret };
  });
}

const loopbackAddresses = new BlockList();
loopbackAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
loopbackAddresses.addAddress('::1', 'ipv6');

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost') return true;
  const family = isIP(normalized);
  return family !== 0 && loopbackAddresses.check(normalized, family === 4 ? 'ipv4' : 'ipv6');
}

function isSafeProductionOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && !isLoopbackHost(url.hostname);
  } catch { return false; }
}

export function readConfig(env: Environment = process.env): FoundationConfig {
  const environment = required(env, 'APP_ENV');
  if (environment !== 'local' && environment !== 'test' && environment !== 'production') {
    throw new Error('APP_ENV must be local, test, or production');
  }
  const host = required(env, 'HOST');
  const port = Number(required(env, 'PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port');
  const authMode = required(env, 'AUTH_MODE');
  if (authMode !== 'mock' && authMode !== 'toss') throw new Error('AUTH_MODE must be mock or toss');
  const subjectSecret = required(env, 'AUTH_SUBJECT_SECRET');
  if (subjectSecret.length < 32) throw new Error('AUTH_SUBJECT_SECRET must be at least 32 characters');
  const activeSubjectSecretVersion = subjectSecretVersion(env.AUTH_SUBJECT_SECRET_VERSION ?? 'v1');
  const priorSubjectSecrets = previousSubjectSecrets(env.AUTH_SUBJECT_PREVIOUS_SECRETS, activeSubjectSecretVersion, subjectSecret);
  const allowedOrigins = required(env, 'ALLOWED_ORIGINS').split(',').map((origin) => origin.trim()).filter(Boolean);
  if (!allowedOrigins.length) throw new Error('ALLOWED_ORIGINS must contain an origin');

  if (authMode === 'mock' && (environment === 'production' || !isLoopbackHost(host))) {
    throw new Error('mock authentication requires local/test environment and a loopback host');
  }
  if (environment === 'production' && allowedOrigins.some((origin) => !isSafeProductionOrigin(origin))) {
    throw new Error('production origins must be HTTPS and non-loopback');
  }
  const tossCertPath = env.TOSS_MTLS_CERT_PATH;
  const tossKeyPath = env.TOSS_MTLS_KEY_PATH;
  if (authMode === 'toss' && (!tossCertPath || !tossKeyPath)) {
    throw new Error('Toss authentication requires mTLS certificate and key paths');
  }
  return {
    environment,
    host,
    port,
    databaseUrl: required(env, 'DATABASE_URL'),
    authMode,
    subjectSecret,
    subjectSecretVersion: activeSubjectSecretVersion,
    previousSubjectSecrets: priorSubjectSecrets,
    allowedOrigins,
    tossCertPath,
    tossKeyPath,
  };
}
