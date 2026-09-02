# Fixture vault (synthetic)

A writing vault with the **exact layout, filenames, frontmatter and table shapes**
of the real one pablo reads, and **entirely invented content**. Every character,
place, date and line of prose here belongs to a made-up novel about a Maine ice
house; none of it comes from any manuscript.

That split is deliberate. `OpenThinkAi/pablo` has a public GitHub mirror, and the
context pack is tested against the *structure* of a vault, not against anybody's
book. What the tests assert is the layout:

```
QWEN.md                                 shared behaviour and rules
style/prose.md, style/anti-tells.md     the shared style guide
novels/<slug>/QWEN.md                   the work's own rules (## Setting and period facts)
novels/<slug>/bible/timeline.md         | Year | Real events | In the novel |
novels/<slug>/bible/places.md
novels/<slug>/bible/characters/         family-tree.md and one file per character
novels/<slug>/outline/chapters.md       | # | Story date | Title | Beat | POV | Status |
novels/<slug>/chapters/NN-slug.md       frontmatter: chapter, title, pov, story_date, status, words
novels/<slug>/continuity.md
novels/<slug>/notes/, research/
```

The style guide here quotes the **rules** of the real `style/prose.md` (they are
rules, and pablo's craft slice is built from them); the flagged examples under
each rule are invented to match this fixture's story.
