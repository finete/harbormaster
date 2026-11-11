// Engine: parse a pull-request URL (`https://github.com/org/repo/pull/12`)
// into the normalized repository id core uses (`github.com/org/repo`, see
// GitRepositoryAccess) and the PR number. Pure.

export interface PullRequestReference {
  repositoryId: string;
  number: number;
}

export function parsePullRequestUrl(
  url: string,
): PullRequestReference | undefined {
  const match = url
    .trim()
    .match(
      /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/pull\/(\d+)(?:[/?#].*)?$/i,
    );
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return undefined;
  return {
    repositoryId: `${match[1]}/${match[2]}/${match[3]}`.toLowerCase(),
    number: Number(match[4]),
  };
}
