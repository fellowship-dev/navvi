# Credential Management

Navvi uses [gopass](https://github.com/gopasspw/gopass) for credential storage. One GPG key unlocks everything.

## Setup

### 1. Generate a GPG key (once, on your machine)

```bash
gpg --full-generate-key
# Choose: RSA, 4096 bits, no expiration
# Use your persona email
```

### 2. Export the private key

```bash
gpg --armor --export-secret-keys YOUR_KEY_ID > /tmp/gpg-key.asc
```

### 3. Pass as environment variable

**Local mode (Docker):**
```bash
# Pass via docker run
docker run -e GPG_PRIVATE_KEY="$(cat /tmp/gpg-key.asc)" navvi

# Or via .env file (never commit this)
echo "GPG_PRIVATE_KEY=$(cat /tmp/gpg-key.asc)" >> .env
```

**Remote mode (Codespace):**
Go to GitHub → Settings → Codespaces → Secrets → New secret:
- Name: `GPG_PRIVATE_KEY`
- Value: contents of `/tmp/gpg-key.asc`
- Repository access: `fellowship-dev/navvi`

Delete the exported file: `rm /tmp/gpg-key.asc`

### 4. Automatic initialization

The container's `start.sh` imports the GPG key and initializes gopass on boot. The key is unset from the environment after import — it only lives in the GPG keyring.

## Adding Credentials

```bash
# Add a service credential
gopass insert navvi/dev/devto
```

Use the multiline format (first line = password, then key-value pairs):

```
hunter2
username: myuser
url: https://dev.to/enter
totp: otpauth://totp/dev.to:myuser?secret=JBSWY3DPEHPK3PXP
```

## Using Credentials

```bash
# List all credentials for a persona
./scripts/navvi.sh creds dev

# Show specific service
./scripts/navvi.sh creds dev devto

# Get credentials for auto-login (writes JSON to temp file)
./scripts/navvi.sh login dev devto
```

## TOTP / 2FA

gopass has built-in OTP support. Store the `totp:` URI in the credential entry:

```bash
# Add TOTP seed
gopass insert navvi/dev/devto
# Include: totp: otpauth://totp/...

# Generate current code
gopass otp navvi/dev/devto
```

## Gopass Store Structure

```
~/.local/share/gopass/stores/root/
└── navvi/
    ├── dev/
    │   ├── devto.age
    │   ├── github.age
    │   └── lobsters.age
    └── max-test/
        └── linkedin.age
```

## Security Model

- **One secret**: GPG private key stored as Codespace secret
- **Encrypted at rest**: all credentials encrypted with GPG
- **No plaintext**: credentials never in YAML, env files, or git
- **Auto-cleanup**: `navvi login` writes to temp file, auto-deleted after 30s
- **Syncable**: gopass store can live in a private repo (encrypted, safe to push)
