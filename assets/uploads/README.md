# Hero image uploads

Drop the five farm photos into THIS folder with the filenames below.
Once they're committed and pushed, the hero on each page will pick
them up automatically (no code change needed).

| Filename                  | Used on                                  | Suggested photo                                |
|---------------------------|------------------------------------------|------------------------------------------------|
| `combine-sunset.jpg`      | Homepage hero (poster fallback for video)| Combine harvester at sunset, wide              |
| `shearing-shed.jpg`       | /the-fight hero                          | Sheep in shearing shed, interior               |
| `tractor-ploughing.jpg`   | /take-action/hold-the-gate hero          | John Deere tractor, drone shot over field      |
| `combine-harvest.jpg`     | /take-action/volunteer hero              | Combine with full hopper of wheat              |
| `lambs-sunset.jpg`        | /donate hero ("They have billions…")     | Lambs + ewes at pink sunset                    |

## Notes

- JPG or WEBP, 1600–2400px wide, ≤500 KB each is a good target.
- They'll be rendered as `background-image: cover` with a navy scrim
  for legibility — composition matters more than exact aspect ratio.
- To swap a photo per page, just edit the `heroImage` field on the
  matching block in `content/site.json` (or use the CMS).
