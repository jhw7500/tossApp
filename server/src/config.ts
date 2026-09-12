import { BlockList, isIP } from 'node:net';
import { readAiConfig, type AiConfig } from './ai/config.ts';

export interface FoundationConfig {
  environment: 'local' | 'test' | 'production';
  host: string;
  port: number;
  databaseUrl: string;
  authMode: 'mock' | 'toss';
  subjectSecret: string;
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
  return { environment, host, port, databaseUrl: required(env, 'DATABASE_URL'), authMode, subjectSecret, allowedOrigins, tossCertPath, tossKeyPath };
}
