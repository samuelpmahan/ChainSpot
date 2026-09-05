# Stage-aware referee checkpoint

`./lab sweep audit S3_RUN_DIRECTORY TRUTH.json [VISIBILITY.json]` restores the actual Stage PxC, checks its checksum and source bytes, and writes diagnostic source-pixel crops without rerunning a detector. One-to-one maximum-cardinality matching uses 7 px total forgiveness and reports extras independently. No raw truth is written into ALG.

Independent visual review of all 72 Dev4 Tee neighborhoods: 64 complete visible frames and 8 partial frames. DashsTrack partial: H3, H5 (circular overlays interrupt frames), H12 (Basket). Heritage partial: H5, H6, H10 (Basket fragments). Lenard partial: H3 (interrupted frame). TowneLake partial: H13 (interrupted frame next to Basket). No reviewed Tee is invisible. All other Tee frames are VISIBLE, including Heritage H15: its complete outline connects to a Badge; detection failure does not justify relabeling it PARTIAL.

Fresh clean S3: 63/64 required complete Tees, 0/8 partial recovered, 3 unrelated UI glyphs accepted (DashsTrack). Stage expectations do matter, but cannot excuse the UI false positives or Heritage H15. Clean S2 finds 66/72 annotated baskets at 7 px. No promotion.

DashsTrack annotation is raw-source and maps via exact retained crop (top4). Other three annotations carry historical crop dimensions differing by 3-4 px. Auditor declares that uncertainty and uses the owner's 7 px total forgiveness; it does not optimize per-course shifts against coordinates or silently weaken production truth matching.

Legacy full Sweep executed all four: DashsTrack 18 assignments but its grader reports wrong Baskets H1/H2. Heritage 17 assignments with false recoveries beside houses. Lenard/Towne 18 assignments. Only DashsTrack receives built-in truth scoring; other three are skipped for frame mismatch. The rendered cyan lines terminate at Badges, not Baskets. `routing.ts` allows all in-image cells with finite costs, not hard corridor membership. Existing straight-test acceptance explicitly abstains in blind mode.

Local tests: 9 new referee tests pass. The packaged `.bin/svelte-kit` launcher is a copied symlink target and resolves imports incorrectly; used its existing real entrypoint `node node_modules/@sveltejs/kit/svelte-kit.js sync`, then `node node_modules/vitest/vitest.mjs run tests/unit/stageAwareAudit.test.ts`. No installation. Shell git cannot resolve github.com; connector commits work.

Next: source-only local Tee/Badge resolution on restored PxC; reuse surviving Basket recovery; test actual path containment separately from endpoint identity and non-vacuous completeness. Preserve frozen clean/ and distinguish all truth-assisted/oracle lanes from ALG success.
