import { describe, expect, it } from "bun:test";

import { addGitHubCredentialHelperEnvironment } from "./github-auth-env.ts";

describe("addGitHubCredentialHelperEnvironment", () => {
	it("GitHub token がなければ environment を変更しない", () => {
		expect(addGitHubCredentialHelperEnvironment({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
	});

	it("GH_TOKEN があれば Git HTTPS credential helper を追加する", () => {
		const result = addGitHubCredentialHelperEnvironment({ GH_TOKEN: "secret" });

		expect(result?.GIT_CONFIG_COUNT).toBe("1");
		expect(result?.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
		expect(result?.GIT_CONFIG_VALUE_0).toContain("x-access-token");
		expect(result?.GIT_CONFIG_VALUE_0).toContain("GH_TOKEN");
		expect(result?.GIT_CONFIG_VALUE_0).not.toContain("secret");
	});

	it("既存の Git config env があれば末尾に追加する", () => {
		const result = addGitHubCredentialHelperEnvironment({
			GITHUB_TOKEN: "secret",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "safe.directory",
			GIT_CONFIG_VALUE_0: "*",
		});

		expect(result?.GIT_CONFIG_COUNT).toBe("2");
		expect(result?.GIT_CONFIG_KEY_0).toBe("safe.directory");
		expect(result?.GIT_CONFIG_VALUE_0).toBe("*");
		expect(result?.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
	});
});
