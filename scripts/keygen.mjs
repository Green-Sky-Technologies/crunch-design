// Prints a new credential master key entry: `<id>:<base64>`.
import { randomBytes } from 'node:crypto';
const id = process.argv[2] ?? `k${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
console.log(`${id}:${randomBytes(32).toString('base64')}`);
