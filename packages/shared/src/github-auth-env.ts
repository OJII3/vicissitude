const GITHUB_GIT_CREDENTIAL_HELPER =
	"!f() { echo username=x-access-token; echo password=${GH_TOKEN:-$GITHUB_TOKEN}; }; f";

export function addGitHubCredentialHelperEnvironment(
	environment: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!environment) return;
	const next = { ...environment };
	if (!next.GH_TOKEN && !next.GITHUB_TOKEN) return next;

	const index = nextGitConfigIndex(next);
	next.GIT_CONFIG_COUNT = String(index + 1);
	next[`GIT_CONFIG_KEY_${index}`] = "credential.https://github.com.helper";
	next[`GIT_CONFIG_VALUE_${index}`] = GITHUB_GIT_CREDENTIAL_HELPER;
	return next;
}

function nextGitConfigIndex(environment: Record<string, string>): number {
	const raw = environment.GIT_CONFIG_COUNT;
	if (raw === undefined) return 0;
	const count = Number(raw);
	if (!Number.isInteger(count) || count < 0) {
		throw new Error("GIT_CONFIG_COUNT must be a non-negative integer");
	}
	return count;
}
