import { setTimeout as delay } from 'node:timers/promises';

const deployments = '/repos/{owner}/{repo}/pages/deployments';
const terminalFailures = new Map([
  ['deployment_content_failed', 'GitHub Pages rejected the release content.'],
  ['deployment_failed', 'GitHub Pages reported that deployment failed.'],
  ['deployment_cancelled', 'GitHub Pages cancelled the deployment.'],
  ['deployment_lost', 'GitHub Pages lost the final deployment status.']
]);

export async function deployPages({ request, getIdToken, repository, commit, artifactId, log = () => {},
  now = Date.now, sleep = delay, timeoutMs = 600000, intervalMs = 5000 }) {
  const id = Number(artifactId);
  if (!/^[1-9]\d*$/.test(artifactId ?? '') || !Number.isSafeInteger(id)
      || !/^[a-f0-9]{40}$/.test(commit ?? '') || !repository?.owner || !repository?.repo) {
    throw new Error('A verified artifact ID and distribution commit are required for Pages.');
  }

  let oidcToken;
  try { oidcToken = await getIdToken(); }
  catch { throw new Error('GitHub Actions could not issue the Pages deployment identity.'); }

  let deployment;
  try {
    ({ data: deployment } = await request(`POST ${deployments}`, {
      ...repository, artifact_id: id, pages_build_version: commit, oidc_token: oidcToken,
      request: { signal: AbortSignal.timeout(30000) }
    }));
  } catch (error) {
    const status = Number.isInteger(error.status) ? ` (HTTP ${error.status})` : '';
    throw new Error(`GitHub Pages could not confirm creation of the deployment${status}.`);
  }

  // Pages also accepts the exact commit SHA when the creation response omits an ID.
  const deploymentId = String(deployment?.id ?? commit);
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(deploymentId)) throw new Error('GitHub Pages returned an invalid deployment ID.');
  log(`GitHub Pages accepted verified artifact ${artifactId}.`);
  const params = { ...repository, deploymentId };
  const deadline = now() + timeoutMs;
  let finished = false;

  try {
    while (now() < deadline) {
      let status;
      try {
        const response = await request(`GET ${deployments}/{deploymentId}`, {
          ...params, request: { signal: AbortSignal.timeout(Math.max(1, Math.min(10000, deadline - now()))) }
        });
        status = response.data?.status;
      } catch (error) {
        if (error.status && ![404, 408, 429].includes(error.status) && error.status < 500) {
          throw new Error(`GitHub Pages refused the deployment status check (HTTP ${error.status}).`);
        }
        // Delayed status visibility and transient read errors can settle in this run.
      }

      if (status === 'succeed') {
        finished = true;
        log('GitHub Pages confirmed deployment success.');
        const url = URL.parse(deployment?.page_url ?? '');
        return url?.protocol === 'https:' && !url.username && !url.password ? url.href : null;
      }
      if (terminalFailures.has(status)) {
        finished = true;
        throw new Error(terminalFailures.get(status));
      }

      const remaining = deadline - now();
      if (remaining > 0) await sleep(Math.min(intervalMs, remaining));
    }
    throw new Error('GitHub Pages did not finish deploying before the deadline.');
  } finally {
    if (!finished) {
      try {
        await request(`POST ${deployments}/{deploymentId}/cancel`, {
          ...params, request: { signal: AbortSignal.timeout(10000) }
        });
      } catch { log('GitHub Pages did not confirm cancellation.'); }
    }
  }
}
