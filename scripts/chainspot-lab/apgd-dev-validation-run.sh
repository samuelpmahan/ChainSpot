#!/usr/bin/env bash
set -uo pipefail

ROOT="$PWD"
APGD="$ROOT/.apgd"
CORPUS="$ROOT/chainspot-corpus"
FINAL="$APGD/final"
LOG="$FINAL/runtime.log"
STATUS="$FINAL/validation-attempt.md"

rm -rf "$APGD"
mkdir -p "$APGD/traces" "$APGD/cache" "$APGD/dev" "$APGD/validation" "$FINAL"

printf 'run_commit=%s\ncorpus_commit=%s\n' "${GITHUB_SHA:-local}" "$(git -C "$CORPUS" rev-parse HEAD)" > "$LOG"
printf '# APGD sealed validation attempt\n\nStatus: RUNNING\n\n' > "$STATUS"

LAST_STAGE='initialization'

publish_status() {
	local status="$1"
	local code="$2"
	{
		printf '# APGD sealed validation attempt\n\n'
		printf 'Status: **%s**\n\n' "$status"
		printf 'Last stage: `%s`\n\n' "$LAST_STAGE"
		printf 'Exit code: `%s`\n\n' "$code"
		printf 'Run commit: `%s`\n\n' "${GITHUB_SHA:-local}"
		printf 'Corpus commit: `%s`\n\n' "$(git -C "$CORPUS" rev-parse HEAD)"
		printf 'Final prediction images currently present: `%s`\n' "$(find "$FINAL" -maxdepth 1 -type f -name '*-prediction.png' | wc -l | tr -d ' ')"
	} > "$STATUS"
}

housekeep() {
	local stage="$1"
	# Intermediate/debug images are never allowed to accumulate. The only image
	# exception is the four final prediction PNGs emitted by the final model.
	find "$APGD" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) \
		! -path "$FINAL/*-prediction.png" -delete 2>/dev/null || true
	printf 'housekeeping stage=%s files=%s images=%s\n' \
		"$stage" \
		"$(find "$APGD" -type f | wc -l | tr -d ' ')" \
		"$(find "$APGD" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) | wc -l | tr -d ' ')" \
		>> "$LOG"
	# Hash text/cache checkpoints; avoid hashing multi-megabyte field planes on
	# every stage just to simulate a pause.
	find "$APGD" -type f \( -name '*.json' -o -name '*.log' -o -name '*.md' \) -print0 2>/dev/null \
		| sort -z \
		| xargs -0 -r sha256sum >> "$LOG"
}

run_stage() {
	local name="$1"
	shift
	LAST_STAGE="$name"
	local start end code
	start=$(date +%s)
	printf '\n=== START %s ===\n' "$name" >> "$LOG"
	set +e
	timeout 40s "$@" >> "$LOG" 2>&1
	code=$?
	set -e
	end=$(date +%s)
	printf '=== END %s code=%s wall=%ss ===\n' "$name" "$code" "$((end-start))" >> "$LOG"
	housekeep "$name"
	if [[ "$code" -ne 0 ]]; then
		publish_status FAILED "$code"
		return "$code"
	fi
	return 0
}

must_run() {
	if ! run_stage "$@"; then
		exit $?
	fi
}

# Exact dev raster inputs expected by the existing D08 matrix producer.
must_run 'make NUP1 DashsTrack' npx tsx scripts/chainspot-lab/apgd-make-nup1.ts \
	"$CORPUS/dev/DashsTrack/DashsTrack-full.jpg" "$APGD/traces/DashsTrack-full.rgba.bin"
must_run 'make NUP1 HeritagePark' npx tsx scripts/chainspot-lab/apgd-make-nup1.ts \
	"$CORPUS/dev/Heritage/HeritagePark-full.png" "$APGD/traces/HeritagePark-full.rgba.bin"
must_run 'make NUP1 Lenard' npx tsx scripts/chainspot-lab/apgd-make-nup1.ts \
	"$CORPUS/dev/Lenard/Lenard-full.PNG" "$APGD/traces/Lenard-full.rgba.bin"
must_run 'make NUP1 TowneLake' npx tsx scripts/chainspot-lab/apgd-make-nup1.ts \
	"$CORPUS/dev/TowneLake/TowneLake-full.png" "$APGD/traces/TowneLake-full.rgba.bin"

for course in DashsTrack-full HeritagePark-full Lenard-full TowneLake-full; do
	must_run "dev D08 $course" env \
		NUTHING_TRACE_DIR="$APGD/traces" \
		CHAINSPOT_CORPUS_PATH="$CORPUS" \
		npx tsx scripts/nuthing/pair-matrix.ts "$APGD/cache" --course "$course"	cp "$APGD/cache/$course.json" "$APGD/dev/$course.json"
done

# Extract exactly the frozen feature set from real D08 dev legs.
must_run 'features DashsTrack' npx tsx scripts/chainspot-lab/apgd-leg-features.ts \
	--cache "$APGD/dev/DashsTrack-full.json" \
	--field "$APGD/cache/DashsTrack-full-field.bin" \
	--image "$CORPUS/dev/DashsTrack/DashsTrack-full.jpg" \
	--out "$APGD/dev/DashsTrack-full.features.json"
must_run 'features HeritagePark' npx tsx scripts/chainspot-lab/apgd-leg-features.ts \
	--cache "$APGD/dev/HeritagePark-full.json" \
	--field "$APGD/cache/HeritagePark-full-field.bin" \
	--image "$CORPUS/dev/Heritage/HeritagePark-full.png" \
	--out "$APGD/dev/HeritagePark-full.features.json"
must_run 'features Lenard' npx tsx scripts/chainspot-lab/apgd-leg-features.ts \
	--cache "$APGD/dev/Lenard-full.json" \
	--field "$APGD/cache/Lenard-full-field.bin" \
	--image "$CORPUS/dev/Lenard/Lenard-full.PNG" \
	--out "$APGD/dev/Lenard-full.features.json"
must_run 'features TowneLake' npx tsx scripts/chainspot-lab/apgd-leg-features.ts \
	--cache "$APGD/dev/TowneLake-full.json" \
	--field "$APGD/cache/TowneLake-full-field.bin" \
	--image "$CORPUS/dev/TowneLake/TowneLake-full.png" \
	--out "$APGD/dev/TowneLake-full.features.json"

# Sealed validation: candidate generation sees only raster pixels.
declare -A VIMAGE=(
	[BeaverRanch-Gold]="$CORPUS/validation/BeaverRanch-Gold/clean/BeaverRanch-Gold-full.PNG"
	[ColetoCreek]="$CORPUS/validation/ColetoCreek/clean/ColetoCreek-full.PNG"
	[FountainHills]="$CORPUS/validation/FountainHills/clean/FountainHills-full.PNG"
	[Seatac]="$CORPUS/validation/Seatac/clean/Seatac-full.PNG"
)

for course in BeaverRanch-Gold ColetoCreek FountainHills Seatac; do
	must_run "blind D08 $course" npx tsx scripts/chainspot-lab/apgd-blind-d08.ts \
		--input "${VIMAGE[$course]}" \
		--out "$APGD/validation/$course.json" \
		--course "$course"
	must_run "validation features $course" npx tsx scripts/chainspot-lab/apgd-leg-features.ts \
		--cache "$APGD/validation/$course.json" \
		--field "$APGD/validation/$course-field.bin" \
		--image "${VIMAGE[$course]}" \
		--out "$APGD/validation/$course.features.json"
done

# One frozen spec: LOCO is reported only; it does not select another model.
must_run 'fixed fit + sealed predictions' npx tsx scripts/chainspot-lab/apgd-fit-validation.ts \
	--dev "$APGD/dev" \
	--validation "$APGD/validation" \
	--corpus "$CORPUS" \
	--out "$FINAL"

LAST_STAGE='final artifact audit'
count=$(find "$FINAL" -maxdepth 1 -type f -name '*-prediction.png' | wc -l | tr -d ' ')
if [[ "$count" -ne 4 ]]; then
	printf 'Expected exactly four final prediction images; got %s\n' "$count" >> "$LOG"
	publish_status FAILED 90
	exit 90
fi
housekeep 'final artifact audit'
sha256sum "$FINAL"/* > "$FINAL/SHA256SUMS"
publish_status SUCCESS 0
printf 'retained_prediction_images=4\n' >> "$LOG"
exit 0
