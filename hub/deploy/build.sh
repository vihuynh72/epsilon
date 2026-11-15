#!/bin/sh
# Builds the hosted band page (no server, no messaging) into $1 (default: dist/epsilon-band).
#   sh hub/deploy/build.sh && vercel deploy dist/epsilon-band --prod --yes
set -e
cd "$(dirname "$0")/../.."
OUT="${1:-dist/epsilon-band}"
rm -rf "$OUT"
mkdir -p "$OUT/hub/sources/band" "$OUT/vexo-open-kit/js" "$OUT/vexo-open-kit/projects/shared" "$OUT/vexo-open-kit/projects/gesture-trainer"
cp hub/sources/band/*.js hub/sources/band/*.css hub/sources/band/index.html "$OUT/hub/sources/band/"
cp hub/messages.json "$OUT/hub/sources/band/words.json"
cp -R vexo-open-kit/js/src "$OUT/vexo-open-kit/js/src"
cp vexo-open-kit/LICENSE "$OUT/vexo-open-kit/"
cp vexo-open-kit/projects/shared/kit.js vexo-open-kit/projects/shared/page.js vexo-open-kit/projects/shared/icon.png "$OUT/vexo-open-kit/projects/shared/"
cp vexo-open-kit/projects/gesture-trainer/motions.js vexo-open-kit/projects/gesture-trainer/recogniser.js "$OUT/vexo-open-kit/projects/gesture-trainer/"
cat > "$OUT/index.html" <<'HTML'
<!doctype html><meta charset="utf-8"><title>Epsilon</title><meta http-equiv="refresh" content="0; url=/hub/sources/band/"><a href="/hub/sources/band/">Epsilon band page</a>
HTML
cat > "$OUT/vercel.json" <<'JSON'
{ "headers": [{ "source": "/(.*)", "headers": [{ "key": "Permissions-Policy", "value": "serial=(self), bluetooth=(self)" }] }] }
JSON
echo "built $OUT"
