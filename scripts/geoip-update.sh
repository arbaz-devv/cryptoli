#!/bin/sh
# Safe GeoIP database update via MaxMind direct download.
#
# Downloads GeoLite2-City.mmdb using curl + Basic Auth with SHA256 verification.
# Writes to a staging directory; only copies to production on success.
# On any failure, existing data is untouched. Always exits 0.

# Load .env if present (shell scripts don't get dotenv automatically)
[ -f .env ] && set -a && . ./.env && set +a

DATA_DIR="data/geoip"
STAGING_DIR="/tmp/geoip-staging"
EDITION="GeoLite2-City"
BASE_URL="https://download.maxmind.com/geoip/databases/${EDITION}/download"

if [ -z "$MAXMIND_ACCOUNT_ID" ] || [ -z "$MAXMIND_LICENSE_KEY" ]; then
  echo "MAXMIND_ACCOUNT_ID or MAXMIND_LICENSE_KEY not set, skipping GeoIP update."
  exit 0
fi

cleanup() {
  rm -rf "$STAGING_DIR"
}

cleanup
mkdir -p "$STAGING_DIR" "$DATA_DIR"

echo "Updating GeoIP database..."

# Download database and checksum
if ! curl -sS -L -f -u "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
     -o "$STAGING_DIR/db.tar.gz" "${BASE_URL}?suffix=tar.gz"; then
  echo "WARNING: GeoIP download failed. Using existing database."
  cleanup
  exit 0
fi

if ! curl -sS -L -f -u "${MAXMIND_ACCOUNT_ID}:${MAXMIND_LICENSE_KEY}" \
     -o "$STAGING_DIR/db.tar.gz.sha256" "${BASE_URL}?suffix=tar.gz.sha256"; then
  echo "WARNING: GeoIP checksum download failed. Using existing database."
  cleanup
  exit 0
fi

# Verify SHA256 checksum
EXPECTED_HASH=$(awk '{print $1}' "$STAGING_DIR/db.tar.gz.sha256")
ACTUAL_HASH=$(sha256sum "$STAGING_DIR/db.tar.gz" | awk '{print $1}')

if [ "$EXPECTED_HASH" != "$ACTUAL_HASH" ]; then
  echo "WARNING: GeoIP checksum mismatch. Using existing database."
  cleanup
  exit 0
fi

# Extract .mmdb and copy to data directory
if tar -xzf "$STAGING_DIR/db.tar.gz" -C "$STAGING_DIR" \
   && cp "$STAGING_DIR"/*/"${EDITION}.mmdb" "$DATA_DIR/${EDITION}.mmdb"; then
  echo "GeoIP database updated successfully."
else
  echo "WARNING: GeoIP extraction failed. Using existing database."
fi

cleanup
exit 0
