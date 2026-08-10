# Google Maps key setup (optional)

ChainSpot runs fully keyless by default: course search uses OpenStreetMap
Nominatim and the basemap comes from USGS NAIP. Configuring a Google Maps
Platform key upgrades exactly two things:

1. **Course search** uses Google Places Text Search, whose POI data knows
   disc golf courses that OSM does not (this is the reason the feature
   exists — Nominatim had never heard of Dash's Track).
2. **A satellite confirm step** appears after picking a search result: a
   real Google Map you pan/zoom until the crosshair sits on the course,
   which then feeds the NAIP fetch.

Everything else — the NAIP basemap, the exports — is unchanged. Exported
graphics never contain Google imagery: NAIP is US-government public domain
and broadcast-safe; Google's satellite imagery is not licensable for
export/broadcast through the Maps APIs at any tier.

## Why the key is allowed to be public

The key ships in the built JS bundle — that is unavoidable in a static
site, and it is the model Google designed browser keys for. Secrecy is not
the control; **restrictions are**:

- an HTTP-referrer restriction pins it to this site's origin,
- an API restriction limits it to the two APIs used,
- quota caps bound the worst case to "the free tier gets used up,"
  never a bill.

Do not skip the restrictions. An unrestricted key in a public repo/bundle
is the one genuinely dangerous configuration.

## One-time setup (~10 minutes)

1. **Create a Google Cloud project** at <https://console.cloud.google.com>
   (any name, e.g. `chainspot-maps`). Billing must be attached (free-tier
   usage still requires a billing account on file).
2. **Enable two APIs** (APIs & Services → Library):
   - *Places API (New)* — text search
   - *Maps JavaScript API* — the confirm-step map
3. **Create the key** (APIs & Services → Credentials → Create credentials
   → API key), then immediately edit it:
   - **Application restrictions** → *Websites*, add:
     - `https://<owner>.github.io/ChainSpot/*` (the deployed site)
     - `http://localhost:5173/*` (local dev; drop when not needed)
   - **API restrictions** → *Restrict key* → select only
     *Places API (New)* and *Maps JavaScript API*.
4. **Cap the quotas** (APIs & Services → Quotas, filter per API): set
   per-day request caps comfortably inside the free monthly allowances
   (Places Text Search: 5,000 free/month; Dynamic Maps loads: 10,000
   free/month). E.g. 150/day each is far more than real usage and can
   never exit the free tier.
5. **Set a billing alert** (Billing → Budgets & alerts): budget $1,
   alert at 50%. It should never fire; if it does, the caps are wrong.
6. **Wire the key in**:
   - **Deployed site:** repository Settings → Secrets and variables →
     Actions → new secret `GOOGLE_MAPS_API_KEY`. The Pages workflow passes
     it to the build as `PUBLIC_GOOGLE_MAPS_API_KEY`.
   - **Local dev:** put `PUBLIC_GOOGLE_MAPS_API_KEY=<key>` in a `.env`
     file (git-ignored) at the repo root.

No key configured (either place) = the app builds and runs exactly as
before, keyless, with zero requests to Google.

## Cost model and the load-gating rule

At ChainSpot's scale every SKU stays in the free tier, and the app is
built to keep it that way structurally:

- Nothing Google-related loads or fires on page load.
- One Places Text Search request per explicit Search click (never per
  keystroke).
- The Maps JavaScript API is injected only after a search result is
  selected — an abandoned search costs one Places call and **zero** map
  loads. Panning/zooming an open map costs nothing; only the load counts.
- A confirmed course location is cached on its Course Library entry, so a
  known course never needs geocoding again.

## Compliance notes (deliberate decisions, recorded)

- Places results are shown with "powered by Google" attribution; the
  confirm map keeps Google's native attribution visible.
- The coordinate cached in the Course Library is the **user's confirmed
  crosshair placement** (their pin, adjusted by hand on the confirm map),
  stored as user data — not a stored copy of an API response.
- Google imagery is used only inside the live confirm widget, never in
  fetched/exported assets. NAIP remains the only imagery that reaches
  exports.
