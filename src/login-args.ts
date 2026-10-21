// Argument parsing for scripts/muse-code-login.mjs, kept separate so the
// login script's flags are testable without spawning the device flow.

export type LoginArgs = {
  help: boolean;
  cache: string | null;
};

export function parseLoginArgs(argv: readonly string[]): LoginArgs {
  const parsed: LoginArgs = { help: false, cache: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--cache" && argv[i + 1]) {
      parsed.cache = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--help" || argv[i] === "-h") {
      parsed.help = true;
    }
  }
  return parsed;
}
