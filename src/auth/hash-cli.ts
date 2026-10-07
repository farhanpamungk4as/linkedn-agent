import { hashPassword } from "./service.js";

if (process.argv.length > 2) {
  console.error("Password arguments are not accepted. Pipe a password through stdin.");
  process.exit(1);
}

let password = "";
for await (const chunk of process.stdin) password += chunk.toString();
password = password.replace(/\r?\n$/, "");
try { console.log(hashPassword(password)); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
