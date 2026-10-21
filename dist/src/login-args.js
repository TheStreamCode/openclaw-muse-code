// Argument parsing for scripts/muse-code-login.mjs, kept separate so the
// login script's flags are testable without spawning the device flow.
export function parseLoginArgs(argv) {
    const parsed = { help: false, cache: null };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === "--cache" && argv[i + 1]) {
            parsed.cache = argv[i + 1];
            i += 1;
        }
        else if (argv[i] === "--help" || argv[i] === "-h") {
            parsed.help = true;
        }
    }
    return parsed;
}
