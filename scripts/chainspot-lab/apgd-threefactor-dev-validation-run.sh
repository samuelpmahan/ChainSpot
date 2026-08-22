#!/usr/bin/env bash
set -uo pipefail

ROOT="$PWD"
CORPUS="$ROOT/chainspot-corpus"
APGD="$ROOT/.apgd-current"
DEV="$APGD/dev"
VAL="$APGD/validation"
FINAL="$APGD/final"
LOG="$FINAL/runtime.log"
STATUS="$FINAL/validation-attempt.md"

rm -rf "$APGD"
mkdir -p "$DEV" "$VAL" "$FINAL"
printf 'run_commit=%s\ncorpus_commit=%s\n' "${GITHUB_SHA:-local}" "$(git -C "$CORPUS" rev-parse HEAD)" > "$LOG"
printf '# Current ThreeFactor APGD validation attempt\n\nStatus: RUNNING\n' > "$STATUS"
LAST_STAGE='initialization'

publish_status() {
	local state="$1"
	local code="$2"
	{
		printf '# Current ThreeFactor APGD validation attempt\n\n'
		printf 'Status: **%s**\n\n' "$state"
		printf 'Last stage: `%s`\n\n' "$LAST_STAGE"
		printf 'Exit code: `%s`\n\n' "$code"
		printf 'Run commit: `%s`\n\n' "${GITHUB_SHA:-local}"
		printf 'Corpus commit: `%s`\n\n' "$(git -C "$CORPUS" rev-parse HEAD)"
		printf 'Retained final prediction images: `%s`\n' "$(find "$FINAL" -maxdepth 1 -type f -name '*-prediction.png' | wc -l | tr -d ' ')"
	} > "$STATUS"
}

housekeep() {
	local stage="$1"
	find "$APGD" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) \
		! -path "$FINAL/*-prediction.png" -delete 2>/dev/null || true
	printf 'housekeeping stage=%s files=%s images=%s\n' \
		"$stage" \
		"$(find "$APGD" -type f | wc -l | tr -d ' ')" \
		"$(find "$APGD" -type f \( -name '*.png' -o -name '*.jpg' -o -name '*.jpeg' \) | wc -l | tr -d ' ')" \
		>> "$LOG"
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
	local name="$1"
	shift
	if run_stage "$name" "$@"; then
		return 0
	else
		local code=$?
		exit "$code"
	fi
}

# Same current ThreeFactor primitives as measureThreeFactor, but stop after
# badge->endpoint legs. The APGD policy never consumes the Cartesian pair
# materialization, so doing it here only wastes runtime on large holdouts.
MEASURE=(npx tsx scripts/chainspot-lab/apgd-threefactor-leg-cache.ts)
FEATURE=(npx tsx scripts/chainspot-lab/apgd-threefactor-leg-features.ts)

# DEV: annotations attach ownership only after pixel measurement and routing.
must_run 'dev measure DashsTrack' "${MEASURE[@]}" \
	--input "$CORPUS/dev/DashsTrack/DashsTrack-full.jpg" \
	--annotation "$CORPUS/dev/DashsTrack/DashsTrack-full.annotation.json" \
	--course DashsTrack-full --out "$DEV/DashsTrack-full.json"
must_run 'dev features DashsTrack' "${FEATURE[@]}" \
	--cache "$DEV/DashsTrack-full.json" --field "$DEV/DashsTrack-full-field.bin" \
	--image "$CORPUS/dev/DashsTrack/DashsTrack-full.jpg" --out "$DEV/DashsTrack-full.features.json"

must_run 'dev measure HeritagePark' "${MEASURE[@]}" \
	--input "$CORPUS/dev/Heritage/HeritagePark-full.png" \
	--annotation "$CORPUS/dev/Heritage/HeritagePark-full.annotation.json" \
	--course HeritagePark-full --out "$DEV/HeritagePark-full.json"
must_run 'dev features HeritagePark' "${FEATURE[@]}" \
	--cache "$DEV/HeritagePark-full.json" --field "$DEV/HeritagePark-full-field.bin" \
	--image "$CORPUS/dev/Heritage/HeritagePark-full.png" --out "$DEV/HeritagePark-full.features.json"

must_run 'dev measure Lenard' "${MEASURE[@]}" \
	--input "$CORPUS/dev/Lenard/Lenard-full.PNG" \
	--annotation "$CORPUS/dev/Lenard/Lenard-full.annotation.json" \
	--course Lenard-full --out "$DEV/Lenard-full.json"
must_run 'dev features Lenard' "${FEATURE[@]}" \
	--cache "$DEV/Lenard-full.json" --field "$DEV/Lenard-full-field.bin" \
	--image "$CORPUS/dev/Lenard/Lenard-full.PNG" --out "$DEV/Lenard-full.features.json"

must_run 'dev measure TowneLake' "${MEASURE[@]}" \
	--input "$CORPUS/dev/TowneLake/TowneLake-full.png" \
	--annotation "$CORPUS/dev/TowneLake/TowneLake-full.annotation.json" \
	--course TowneLake-full --out "$DEV/TowneLake-full.json"
must_run 'dev features TowneLake' "${FEATURE[@]}" \
	--cache "$DEV/TowneLake-full.json" --field "$DEV/TowneLake-full-field.bin" \
	--image "$CORPUS/dev/TowneLake/TowneLake-full.png" --out "$DEV/TowneLake-full.features.json"

# VALIDATION: no annotation argument. Measurement width is frozen to 37px;
# profile kernels independently use the predeclared 30/37/40 median.
declare -A VIMAGE=(
	[BeaverRanch-Gold]="$CORPUS/validation/BeaverRanch-Gold/clean/BeaverRanch-Gold-full.PNG"
	[ColetoCreek]="$CORPUS/validation/ColetoCreek/clean/ColetoCreek-full.PNG"
	[FountainHills]="$CORPUS/validation/FountainHills/clean/FountainHills-full.PNG"
	[Seatac]="$CORPUS/validation/Seatac/clean/Seatac-full.PNG"
)

for course in BeaverRanch-Gold ColetoCreek FountainHills Seatac; do
	must_run "validation measure $course" "${MEASURE[@]}" \
		--input "${VIMAGE[$course]}" --course "$course" --corridor-width 37 --out "$VAL/$course.json"
	must_run "validation features $course" "${FEATURE[@]}" \
		--cache "$VAL/$course.json" --field "$VAL/$course-field.bin" \
		--image "${VIMAGE[$course]}" --out "$VAL/$course.features.json"
done

must_run 'fixed policy fit + blind prediction' npx tsx scripts/chainspot-lab/apgd-threefactor-fit.ts \
	--dev "$DEV" --validation "$VAL" --out "$FINAL/validation-predictions.json"

for course in BeaverRanch-Gold ColetoCreek FountainHills Seatac; do
	must_run "final render $course" npx tsx scripts/chainspot-lab/apgd-threefactor-render.ts \
		--image "${VIMAGE[$course]}" --cache "$VAL/$course.json" \
		--predictions "$FINAL/validation-predictions.json" --course "$course" \
		--out "$FINAL/$course-prediction.png"
done

LAST_STAGE='final artifact audit'
count=$(find "$FINAL" -maxdepth 1 -type f -name '*-prediction.png' | wc -l | tr -d ' ')
if [[ "$count" -ne 4 ]]; then
	printf 'Expected four final prediction images; found %s\n' "$count" >> "$LOG"
	publish_status FAILED 90
	exit 90
fi
housekeep 'final artifact audit'
sha256sum "$FINAL"/* > "$FINAL/SHA256SUMS"
publish_status SUCCESS 0
printf 'retained_prediction_images=4\n' >> "$LOG"
exit 0
