import { main } from "./triage-cli.js";

// Entry point for `pnpm triage`. Loads .env if there is one (the worktree
// copies it in), then hands over to `main`.

try {
	process.loadEnvFile(".env");
} catch (error) {
	// No .env is fine: the key may already be in the environment.
	if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

process.exitCode = await main(process.argv.slice(2), {
	env: process.env,
	stdout: process.stdout,
	stderr: process.stderr,
});
