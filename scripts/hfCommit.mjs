// Writes files to a Hugging Face repo the way the submitter is allowed to:
// straight to main when they own the repo's namespace (their user or one of
// their orgs) with a token that can write, otherwise as a pull request. If a
// direct commit is refused anyway (fine-grained token without write access, a
// repo that only accepts PRs, or main moved since the files were read), it is
// retried once as a pull request. Used for model .eval_results uploads and for
// publishing benchmark datasets.

const RETRY_AS_PR_STATUS = [401, 403, 409, 412];

export function hubCredentials(env = process.env) {
  const accessToken = env.HF_TOKEN || env.HUGGING_FACE_HUB_TOKEN || null;
  const hubUrl = (env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
  return { accessToken, hubUrl };
}

async function loadHub() {
  return import('@huggingface/hub');
}

/** 'direct' or 'pr', and why, from whoAmI() and the repo id. */
export function decideCommitMode(who, repoId, { forcePr = false } = {}) {
  if (forcePr) return { mode: 'pr', reason: 'a pull request was asked for (pr)' };
  const namespace = repoId.split('/')[0];
  const role = who?.auth?.accessToken?.role;
  if (role === 'read') return { mode: 'pr', reason: 'the token is read-only' };
  if (who?.type === 'user' && (who.name === namespace || (who.orgs ?? []).some((org) => org.name === namespace))) {
    return { mode: 'direct', reason: `${who.name} owns or belongs to ${namespace}` };
  }
  if (who?.type === 'app' && (who.scope?.entities ?? []).includes(namespace) && ['admin', 'write'].includes(who.scope.role)) {
    return { mode: 'direct', reason: `the app token can write to ${namespace}` };
  }
  return { mode: 'pr', reason: `${who?.name ?? 'the token owner'} is not ${namespace} or one of its members` };
}

export async function whoAmIOrNull({ accessToken, hubUrl, hub }) {
  const { whoAmI } = hub ?? await loadHub();
  return whoAmI({ accessToken, hubUrl });
}

/**
 * @param repo        { type: 'model' | 'dataset', name: 'org/name' }
 * @param files       [{ path, content: string | Blob }]
 * @param parentCommit commit the new files were derived from; a direct commit
 *                    fails (and becomes a PR) if main has moved past it
 * @returns { mode, reason, url, commit, fellBack }
 */
export async function commitFiles({
  repo,
  files,
  title,
  description,
  parentCommit,
  forcePr = false,
  env = process.env,
  hub = null,
  log = () => {},
}) {
  const { accessToken, hubUrl } = hubCredentials(env);
  if (!accessToken) throw new Error('Uploading needs a Hugging Face token: run `hf auth login` or set HF_TOKEN');
  const lib = hub ?? await loadHub();
  const who = await whoAmIOrNull({ accessToken, hubUrl, hub: lib });
  const decision = decideCommitMode(who, repo.name, { forcePr });
  log(`Writing to ${repo.type === 'dataset' ? 'datasets/' : ''}${repo.name} as ${who?.name ?? 'unknown'}: ${decision.mode === 'pr' ? 'pull request' : 'direct commit'} (${decision.reason})`);

  const operations = files.map(({ path, content }) => ({
    operation: 'addOrUpdate',
    path,
    content: typeof content === 'string' ? new Blob([content]) : content,
  }));
  const attempt = (isPullRequest) => lib.commit({
    repo,
    accessToken,
    hubUrl,
    title,
    description,
    operations,
    isPullRequest,
    ...(parentCommit ? { parentCommit } : {}),
  });

  if (decision.mode === 'direct') {
    try {
      const output = await attempt(false);
      return { ...decision, url: output.commit.url, commit: output.commit.oid, fellBack: null };
    } catch (error) {
      if (!RETRY_AS_PR_STATUS.includes(error?.statusCode)) throw error;
      const why = `a direct commit was refused (${error.statusCode}: ${error.message})`;
      log(`${why}; opening a pull request instead`);
      const output = await attempt(true);
      return { mode: 'pr', reason: why, url: output.pullRequestUrl ?? output.commit.url, commit: output.commit.oid, fellBack: why };
    }
  }
  const output = await attempt(true);
  return { ...decision, url: output.pullRequestUrl ?? output.commit.url, commit: output.commit.oid, fellBack: null };
}

/** Text of a file in a repo at a revision, or null if it does not exist. */
export async function readRepoText({ repo, path, revision, env = process.env, hub = null }) {
  const { accessToken, hubUrl } = hubCredentials(env);
  const lib = hub ?? await loadHub();
  const blob = await lib.downloadFile({ repo, path, revision, hubUrl, ...(accessToken ? { accessToken } : {}) });
  return blob ? blob.text() : null;
}
