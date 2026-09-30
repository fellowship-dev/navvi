# Secrets

A scraper carries only `{{secret:name}}` placeholders. The value is filled in by
code at replay and never enters a chooser question, a log, a trace or the
scraper JSON: every rendering of a resolved value is `[secret]`.

## Where a value comes from

Each name is resolved in this order, and the first source that has it wins:

1. `input.secrets.<name>` (the CLI's `--secret` / `--secrets-file`)
2. `NAVVI_SECRET_<NAME>` in the environment
3. The sealed bundle: `NAVVI_SECRETS`, opened with `NAVVI_SECRETS_PASSPHRASE`
4. The macOS keychain (service `navvi`, account `<name>`), on macOS only
5. On Apify, the actor's secret source

The bundle is opened only when a name gets past the environment. It is opened
once per run and kept in memory for that run. A bundle that is set but cannot
be opened (missing or wrong passphrase, altered text, another version) ends
the run as `configuration_error`. The message never includes a value.

## The sealed bundle

Seal once on the machine that holds the secrets. After that, the bundle and its
passphrase are the only two values a server needs, whatever the OS.

```sh
export NAVVI_SECRETS_PASSPHRASE="$(openssl rand -base64 32)"   # keep this one in your password manager
navvi secrets seal \
  --name isc2 --from gopass:web/isc2.org \
  --name api_token --from env:MY_API_TOKEN \
  --from file:./more-secrets.json \
  --out navvi-secrets.txt
navvi secrets list --in navvi-secrets.txt                       # names only
```

- `--name <n> --from <source>` can be repeated. If several `--from` follow one
  `--name`, they are tried in order and the first that answers is used. For
  example, `--name pw --from gopass:web/site --from env:SITE_PW` falls back to
  the env variable when gopass is missing. Every source that gives nothing is
  reported by name and reason. The seal fails if a name ends up with no value.
- `gopass:<entry>` reads the password with `gopass show -o <entry>`. It then
  reads the whole entry and picks up these lines, in the old navvi's format:
  password on line one, then `username:`, `url:` and `totp: otpauth://...`.
  The results are sealed as `<n>` (password), `<n>_username` and `totp:<n>`.
  gopass (and gpg) run only here, at seal time.
- `env:<VAR>` seals the value of `VAR` as `<n>`.
- `file:<secrets.json>` is a JSON object of name -> value. Without `--name`,
  every key is sealed; with `--name`, only that key. Keys may be `totp:<name>`.
- The bundle goes to stdout, or with `--out` to a file created with mode 0600.
  Only the sealed names are printed, on stderr.
- `--passphrase-env <VAR>` reads the passphrase at seal time from a variable
  other than `NAVVI_SECRETS_PASSPHRASE`. At run time it is always
  `NAVVI_SECRETS_PASSPHRASE`. It must be at least 12 characters.

A login replays with `--profile local` (the store profile never types into a
password field):

```sh
NAVVI_SECRETS="$(cat navvi-secrets.txt)" navvi "log in and list my CPE credits" https://example.org/login --profile local
```

### Format

`navvi1.<base64url JSON>`. The JSON holds `v`, `kdf: "scrypt"`, `N` (2^15),
`r`, `p`, `salt`, `iv`, `tag` and `ct`. The key is scrypt(passphrase, salt).
The cipher is AES-256-GCM over `{"secrets": {name: value}}`, with the header
fields bound as associated data, so a changed cost parameter fails like a
changed ciphertext. The code uses node:crypto only, with no dependency and no
binary. A bundle whose version navvi does not read is refused with a message
saying to reseal it.

## On Apify

Set two environment variables on the actor (Console -> the actor -> Source ->
Environment variables) and tick **Secret** on both:

| Variable | Value |
|---|---|
| `NAVVI_SECRETS` | the `navvi1.…` line |
| `NAVVI_SECRETS_PASSPHRASE` | the passphrase |

A secret environment variable is encrypted at rest and masked in the Console and
in logs. Actor env vars apply to every run of that build, so rebuild after
changing them. Use a separate actor for each owner's credentials. Do not put
the bundle in the run input: the public input schema has no field for it, and
a run input is stored with the run.

## On a server

Use the same two variables. With systemd, put them in an `EnvironmentFile=` that
only the service user can read:

```ini
# /etc/navvi/secrets.env  (chmod 600, owned by the service user)
NAVVI_SECRETS=navvi1.eyJ2Ijox...
NAVVI_SECRETS_PASSPHRASE=...
```

The bundle alone is useless without the passphrase. If you can, keep the
passphrase in a separate store (a different file, or the platform's secret
manager).

## Rotation

- **A secret changed:** reseal with the new value and replace `NAVVI_SECRETS`.
  The passphrase can stay.
- **Passphrase exposed:** reseal with a new passphrase and replace both
  variables. Assume every value in the old bundle is exposed too, and rotate
  those at their sites.
- **Bundle exposed, passphrase not:** the values stay protected by scrypt and
  the passphrase's strength. Reseal with a new passphrase anyway.
- `navvi secrets list` shows which names a bundle holds, without printing any
  value.

## Why not gpg on servers

The Python navvi (up to `v3.22.0-py`) decrypted gopass on the server. Its
container either imported `GPG_PRIVATE_KEY` or generated an ed25519 key with
an **empty passphrase**, and relied on `gpg-agent` with loopback pinentry.
That meant:

- A private key with no passphrase sat in the image or env, so anyone who could
  read it could read every secret.
- Agent state, pinentry mode and TTY quirks broke unattended runs.
- It depended on a gpg binary and agent that Apify's images do not ship.

The bundle moves gpg and gopass to seal time, on the machine where they already
work. The server does one scrypt and one AES-GCM decryption in-process.

## Also available

- **Keychain** (macOS): `security add-generic-password -s navvi -a <name> -w`.
  Useful on your own Mac. It is not the design centre, because it does not
  exist on Apify or Linux.
- **`NAVVI_SECRET_<NAME>`**: one env var per secret. This source wins over the
  bundle, so you can override a single name without resealing.
