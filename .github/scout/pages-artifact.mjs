import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const identifier = value => /^(?:[1-9]\d*)$/.test(String(value ?? '')) && String(value).length <= 20;
const artifactNameValid = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value);

export class ArtifactMetadataError extends Error {
  constructor(message, retryable = false) { super(message); this.retryable = retryable; }
}

export function githubArtifactLister({ repository, runId, token, fetcher = fetch }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? '') || !identifier(runId) || typeof token !== 'string' || !token) {
    throw new ArtifactMetadataError('Invalid Pages artifact lookup context.');
  }
  const endpoint = `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts`;
  return async ({ artifactName, timeoutMs }) => {
    let response;
    try {
      response = await fetcher(`${endpoint}?name=${encodeURIComponent(artifactName)}&per_page=100`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(10000, Math.ceil(timeoutMs))))
      });
    } catch { throw new ArtifactMetadataError('GitHub artifact metadata is temporarily unavailable.', true); }
    if (!response.ok) {
      const retryable = response.status === 404 || response.status === 429 || response.status >= 500;
      throw new ArtifactMetadataError(`GitHub artifact metadata returned HTTP ${response.status}.`, retryable);
    }
    try { return await response.json(); }
    catch { throw new ArtifactMetadataError('GitHub returned unreadable artifact metadata.', true); }
  };
}

// This read-only gate tolerates delayed REST metadata after upload. The deploy
// action uses another metadata service, so readiness here is useful evidence,
// not a guarantee that every later GitHub service request will succeed.
export async function waitForPagesArtifact({ listArtifacts, artifactName, artifactId, timeoutMs = 60000, intervalMs = 1000,
  now = Date.now, sleep = delay }) {
  if (typeof listArtifacts !== 'function' || !artifactNameValid(artifactName) || !identifier(artifactId)
      || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000
      || !Number.isInteger(intervalMs) || intervalMs < 1 || intervalMs > timeoutMs) {
    throw new ArtifactMetadataError('Invalid Pages artifact readiness configuration.');
  }
  const deadline = now() + timeoutMs;
  let attempts = 0;
  while (now() < deadline) {
    let metadata;
    attempts++;
    try { metadata = await listArtifacts({ artifactName, timeoutMs: Math.max(1, Math.min(10000, deadline - now())) }); }
    catch (error) {
      if (error instanceof ArtifactMetadataError && !error.retryable) throw error;
      // Never retain or print raw HTTP/client errors: they can contain URLs,
      // request headers or token-bearing diagnostics.
    }
    if (metadata) {
      if (!Array.isArray(metadata.artifacts) || !Number.isSafeInteger(metadata.total_count) || metadata.total_count < 0) {
        throw new ArtifactMetadataError('GitHub returned invalid artifact metadata.');
      }
      const matches = metadata.artifacts.filter(artifact => artifact?.name === artifactName);
      if (matches.length > 1 || metadata.total_count > 1) throw new ArtifactMetadataError('Multiple artifacts match the current Pages upload.');
      if (matches.length === 1) {
        const artifact = matches[0];
        if (String(artifact.id) !== String(artifactId)) throw new ArtifactMetadataError('Pages artifact metadata does not match the uploaded artifact ID.');
        if (artifact.expired !== false || !Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1) {
          throw new ArtifactMetadataError('The uploaded Pages artifact is expired or empty.');
        }
        return { id: String(artifact.id), name: artifactName, attempts };
      }
    }
    const remaining = deadline - now();
    if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
  }
  throw new ArtifactMetadataError('The uploaded Pages artifact did not become visible before the readiness deadline.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await waitForPagesArtifact({
      listArtifacts: githubArtifactLister({ repository: process.env.GITHUB_REPOSITORY, runId: process.env.GITHUB_RUN_ID, token: process.env.GH_TOKEN }),
      artifactName: process.env.PAGES_ARTIFACT_NAME, artifactId: process.env.PAGES_ARTIFACT_ID
    });
    console.log(`Pages artifact is ready after ${result.attempts} metadata check(s).`);
  } catch (error) {
    console.error(error instanceof ArtifactMetadataError ? error.message : 'Pages artifact readiness could not be verified.');
    process.exitCode = 1;
  }
}
