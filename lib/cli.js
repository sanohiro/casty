// Command-line options, shared by both entry points through casty.js.
export function parseArgs(args) {
  const options = {};
  let positional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!positional && arg === '--') {
      positional = true;
    } else if (!positional && (arg === '--help' || arg === '-h')) {
      options.help = true;
    } else if (!positional && (arg === '--version' || arg === '-v')) {
      options.version = true;
    } else if (!positional && (arg === '--headless-shell' || arg.startsWith('--headless-shell='))) {
      const path = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++i];
      if (!path || path.startsWith('-')) throw new Error('--headless-shell requires an executable path');
      options.headlessShellPath = path;
    } else if (!positional && arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (options.url === undefined) {
      options.url = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return options;
}
