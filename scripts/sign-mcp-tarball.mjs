#!/usr/bin/env node
/**
 * sign-mcp-tarball.mjs — Release-time DSSE attestation signing for the
 * @ai-sdlc/plugin-mcp-server npm tarball (AISDLC-439, DEC-0001).
 *
 * Run after `pnpm -r publish` completes in the release workflow. Fetches the
 * published tarball from the npm registry, computes its SHA-512, packages the
 * hash into a DSSE attestation predicate
 * (`predicateType: 'https://ai-sdlc.io/mcp-server-tarball/v1'`), signs it
 * with the operator's signing key (same key used for v6 review attestations),
 * and writes the signed envelope to
 * `.ai-sdlc/attestations/mcp-server-<version>.dsse.json`.
 *
 * Usage (CI):
 *   node scripts/sign-mcp-tarball.mjs --version <semver> --key <pem-path>
 *
 * Usage (local / operator):
 *   AISDLC_SIGNING_KEY_PATH=~/.ai-sdlc/signing-key.pem \
 *   node scripts/sign-mcp-tarball.mjs --version 0.9.2
 *
 * Flags:
 *   --version   <semver>   The version to sign (e.g. 0.9.2). Required.
 *   --key       <path>     Override signing key path. Falls back to
 *                          AISDLC_SIGNING_KEY_PATH env, then
 *                          ~/.ai-sdlc/signing-key.pem.
 *   --package   <name>     npm package name. Default: @ai-sdlc/plugin-mcp-server
 *   --registry  <url>      npm registry base URL. Default: https://registry.npmjs.org
 *   --out       <path>     Output envelope path. Default:
 *                          .ai-sdlc/attestations/mcp-server-<version>.dsse.json
 *   --dry-run              Print the unsigned predicate to stdout and exit.
 *                          Useful for debugging without a signing key.
 *
 * Writes:
 *   .ai-sdlc/attestations/mcp-server-<version>.dsse.json
 *
 * Exit codes:
 *   0 — success
 *   1 — fatal error (missing key, fetch failed, signing error)
 */

import { createHash, sign as cryptoSign, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';

/** Predicate type URI — versioned for forward evolution. */
export const TARBALL_PREDICATE_TYPE = 'https://ai-sdlc.io/mcp-server-tarball/v1';

/** Default registry for tarball fetch. */
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Default package name. */
const DEFAULT_PACKAGE = '@ai-sdlc/plugin-mcp-server';

function fail(msg) {
  process.stderr.write(`ERROR: ${msg}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[a.substring(2)] = true;
      } else {
        out[a.substring(2)] = next;
        i++;
      }
    }
  }
  return out;
}

/**
 * Fetch a URL and return the response body as a Buffer.
 * Uses the built-in `fetch` (Node 18+).
 */
async function fetchBuffer(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching ${url}`);
  }
  const buf = await res.arrayBuffer();
  return Buffer.from(buf);
}

/**
 * Extract per-file SHA-512 hashes for a fixed allowlist of files inside a
 * gzipped npm tarball, without depending on any tar parser package. We parse
 * the standard tar header format (ustar magic, 512-byte blocks) directly.
 *
 * The allowlist is `dist/bin.js` plus any other operator-recoverable entry
 * point — keeping it short bounds the predicate size and makes the verifier's
 * comparison loop trivial. Files NOT in the allowlist do not get per-file
 * SHAs; the top-level tarball SHA still binds them via the SLSA subject.
 */
export function computeDistFileSha512s(tarballBuf) {
  const allowlist = new Set(['package/dist/bin.js']);
  const tarBuf = gunzipSync(tarballBuf);
  const results = [];
  let offset = 0;
  while (offset + 512 <= tarBuf.length) {
    const header = tarBuf.subarray(offset, offset + 512);
    // Empty block (two consecutive 512 zero blocks mark EOF).
    if (header[0] === 0) break;
    // ustar magic at byte 257..262 ("ustar\x00") confirms tar format.
    const name = header.subarray(0, 100).toString('utf-8').replace(/\0.*$/, '');
    const sizeStr = header.subarray(124, 136).toString('utf-8').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const fileEnd = offset + 512 + size;
    if (allowlist.has(name) && size > 0) {
      const data = tarBuf.subarray(offset + 512, fileEnd);
      const sha = createHash('sha512').update(data).digest('hex');
      results.push({ path: name.replace(/^package\//, ''), sha512: sha });
    }
    // Move to next header (each file's data is padded to a 512 multiple).
    const padded = Math.ceil(size / 512) * 512;
    offset = offset + 512 + padded;
  }
  return results;
}

/**
 * Compute SHA-512 of a Buffer, returned as lowercase hex.
 */
export function sha512Hex(buf) {
  return createHash('sha512').update(buf).digest('hex');
}

/**
 * Build the DSSE attestation predicate payload for a given tarball.
 *
 * The predicate follows the SLSA v1.0 "statement" container shape, with a
 * custom ai-sdlc predicateType. The verifier
 * (scripts/verify-mcp-tarball.mjs) validates this exact structure.
 */
export function buildTarballPredicate({
  packageName,
  version,
  sha512,
  tarballUrl,
  registry,
  signerIdentity,
  machine,
  distFiles,
}) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [
      {
        name: `${packageName}@${version}`,
        digest: {
          sha512: sha512,
        },
      },
    ],
    predicateType: TARBALL_PREDICATE_TYPE,
    predicate: {
      schemaVersion: 'v1',
      packageName,
      version,
      registry,
      tarballUrl,
      sha512,
      distFiles: distFiles ?? [],
      signedAt: new Date().toISOString(),
      signerIdentity,
      machine,
    },
  };
}

/**
 * Sign a DSSE envelope using the DSSE signing protocol.
 *
 * DSSE envelope format (https://github.com/secure-systems-lab/dsse):
 *   {
 *     payload:     base64(PAE(payloadType, payload)),
 *     payloadType: <string>,
 *     signatures:  [{ keyid, sig: base64(sign(PAE)) }],
 *   }
 *
 * PAE = "DSSEv1" + SP + LEN(payloadType) + SP + payloadType + SP + LEN(payload) + SP + payload
 *
 * The same signing surface is used by sign-attestation.mjs / signAttestation()
 * in orchestrator/dist/runtime/attestations.js — we replicate the PAE
 * construction here so sign-mcp-tarball.mjs can run standalone during CI
 * without requiring the orchestrator dist to be built.
 */
export function signTarballEnvelope({ predicate, privateKeyPem, keyid }) {
  const payloadType = TARBALL_PREDICATE_TYPE;
  const payloadJson = JSON.stringify(predicate, null, 2);
  const payloadBuf = Buffer.from(payloadJson, 'utf-8');

  // PAE = "DSSEv1" SP LEN(payloadType) SP payloadType SP LEN(payload) SP payload
  const pae = Buffer.concat([
    Buffer.from('DSSEv1 '),
    Buffer.from(String(payloadType.length) + ' '),
    Buffer.from(payloadType, 'utf-8'),
    Buffer.from(' '),
    Buffer.from(String(payloadBuf.length) + ' '),
    payloadBuf,
  ]);

  // Ed25519 does not use a separate hash function — pass null as algorithm.
  // Using cryptoSign(null, data, key) is the correct API for ed25519.
  const sigBuf = cryptoSign(null, pae, privateKeyPem);

  return {
    payload: payloadBuf.toString('base64'),
    payloadType,
    signatures: [
      {
        keyid: keyid ?? '',
        sig: sigBuf.toString('base64'),
      },
    ],
  };
}

/**
 * Resolve the npm tarball URL for a given package + version.
 * Fetches the registry metadata and extracts the `dist.tarball` URL.
 */
export async function resolveTarballUrl({ packageName, version, registry }) {
  const metaUrl = `${registry}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const res = await fetch(metaUrl, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching registry metadata: ${metaUrl}`);
  }
  const meta = await res.json();
  const tarballUrl = meta?.dist?.tarball;
  if (!tarballUrl || typeof tarballUrl !== 'string') {
    throw new Error(`Registry metadata for ${packageName}@${version} missing dist.tarball`);
  }
  return tarballUrl;
}

/**
 * Main entry point for CLI invocation.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));

  const version = args['version'];
  if (!version) fail('--version <semver> is required');

  const packageName = args['package'] ?? DEFAULT_PACKAGE;
  const registry = args['registry'] ?? DEFAULT_REGISTRY;
  const repoRoot = resolve(process.cwd());
  const dryRun = Boolean(args['dry-run']);

  // Resolve signing key (dry-run skips key requirement).
  let privateKeyPem = null;
  if (!dryRun) {
    const keyPath =
      args['key'] ??
      process.env['AISDLC_SIGNING_KEY_PATH'] ??
      join(homedir(), '.ai-sdlc', 'signing-key.pem');
    if (!existsSync(keyPath)) {
      fail(
        `No signing key at ${keyPath}.\n` +
          '       Set AISDLC_SIGNING_KEY_PATH or pass --key <path>.\n' +
          '       In CI, write the key from a secret: echo "$AISDLC_SIGNING_KEY" > /tmp/sign.pem',
      );
    }
    privateKeyPem = readFileSync(keyPath, 'utf-8');
  }

  // Resolve output path.
  const outPath =
    args['out'] ?? join(repoRoot, '.ai-sdlc', 'attestations', `mcp-server-${version}.dsse.json`);

  process.stderr.write(`[sign-mcp-tarball] signing ${packageName}@${version} from ${registry}\n`);

  // Resolve tarball URL from registry metadata.
  let tarballUrl;
  try {
    tarballUrl = await resolveTarballUrl({ packageName, version, registry });
  } catch (err) {
    fail(`Failed to resolve tarball URL: ${err.message}`);
  }
  process.stderr.write(`[sign-mcp-tarball] tarball URL: ${tarballUrl}\n`);

  // Fetch tarball and compute SHA-512.
  let tarballBuf;
  try {
    tarballBuf = await fetchBuffer(tarballUrl);
  } catch (err) {
    fail(`Failed to fetch tarball: ${err.message}`);
  }
  const sha512 = sha512Hex(tarballBuf);
  process.stderr.write(
    `[sign-mcp-tarball] tarball size: ${tarballBuf.length} bytes  sha512: ${sha512.slice(0, 16)}...\n`,
  );

  // Extract per-file SHAs for the allowlisted entry-point files inside the
  // tarball — these let the SessionStart hook compare the installed bytes
  // against the signed envelope without having to re-pack the tarball.
  let distFiles = [];
  try {
    distFiles = computeDistFileSha512s(tarballBuf);
    if (distFiles.length > 0) {
      process.stderr.write(
        `[sign-mcp-tarball] distFiles signed: ${distFiles.map((f) => f.path).join(', ')}\n`,
      );
    } else {
      process.stderr.write(
        `[sign-mcp-tarball] WARN: no allowlisted distFiles found in tarball — SessionStart hook will be unable to verify per-file SHAs\n`,
      );
    }
  } catch (err) {
    process.stderr.write(
      `[sign-mcp-tarball] WARN: distFiles extraction failed (${err.message}); continuing with tarball-only SHA\n`,
    );
  }

  // Build predicate.
  const identity =
    process.env['GIT_AUTHOR_EMAIL'] ?? process.env['EMAIL'] ?? `${userInfo().username}@local`;
  const machine = hostname();

  const predicate = buildTarballPredicate({
    packageName,
    version,
    sha512,
    tarballUrl,
    registry,
    signerIdentity: identity,
    machine,
    distFiles,
  });

  if (dryRun) {
    process.stdout.write(JSON.stringify(predicate, null, 2) + '\n');
    return;
  }

  // Sign and write envelope.
  const keyid = `${identity}:${machine}`;
  const envelope = signTarballEnvelope({ predicate, privateKeyPem, keyid });

  mkdirSync(join(repoRoot, '.ai-sdlc', 'attestations'), { recursive: true });
  writeFileSync(outPath, JSON.stringify(envelope, null, 2) + '\n', 'utf-8');

  process.stderr.write(`[sign-mcp-tarball] wrote envelope: ${outPath}\n`);
  process.stdout.write(`${outPath}\n`);
}

// Run main only when invoked directly (not imported as a module in tests).
const isMain =
  process.argv[1] &&
  (process.argv[1].endsWith('sign-mcp-tarball.mjs') ||
    process.argv[1].endsWith('sign-mcp-tarball'));
if (isMain) {
  main().catch((err) => fail(err.message ?? String(err)));
}
