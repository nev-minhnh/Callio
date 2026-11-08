# Security

Please report security problems privately through GitHub: **Security → Report a vulnerability** on
https://github.com/nev-minhnh/Callio. Don't open a public issue for them.

What Callio does to stay safe is described under *Security notes* in the README: sanitized Markdown,
a strict Content-Security-Policy, keys and tokens only in Windows Credential Manager, local servers
bound to 127.0.0.1 with per-start random tokens, and shell escape off by default.
