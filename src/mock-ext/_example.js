// One file per feature: export async function handle(cmd, args) returning the mocked result,
// or undefined when the command is not this feature's. src/mock.js loads every file here (dev only).
export async function handle() { return undefined; }
