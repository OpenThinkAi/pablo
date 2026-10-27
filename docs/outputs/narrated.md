# The narrated output

An audiobook-style reading of another output's prose, in one narrator's voice and
optionally character voices for dialogue. Allowed on every track:
[fiction](../tracks/fiction.md), [historical-fiction](../tracks/historical-fiction.md) and
[nonfiction](../tracks/nonfiction.md). `pablo guide --track <t> --output narrated` prints
the full path; examples use "The Ice House".

## Add it

It reads a prose output the work already has, so write that first (the guide's steps 8-9):

```
pablo output add essay --project ice-house
pablo write --project ice-house --output essay --unit 1       # and accept it
pablo output add narrated --from essay --project ice-house
```

`--from` takes `novel`, `story` or `essay` (on nonfiction, only `essay`). It is refused
without a source, for a script output such as `radio`, and for an output the work lacks;
while narrated reads an output, `output remove` refuses that output. Its units (readings)
mirror the source's units one for one.

## Make a reading

```
pablo write --project ice-house --output narrated --unit 1 [--voices characters]
```

This uses **no model**. A reading is a `CAST:` line, then a `NARRATOR:` line per
paragraph, the source's words unchanged (an essay section is read without its citations).
With `--voices characters`, quoted dialogue whose speaker the paragraph names (exactly one
character from `bible/characters/`) becomes that character's line. It is refused when the
source unit is not written yet, and lands on `draft/narrated-NN`.

`pablo check --output narrated` reports `narration-drift` if a reading's words differ from
its source, plus the track's checks.

## Perform and mix

Narrated readings use the same audio verbs as radio, addressed with `--output narrated`:

```
pablo cast --auto --project ice-house --output narrated [--unit N]
pablo perform --project ice-house --output narrated --unit 1
pablo mix --project ice-house --output narrated --unit 1
```

`fix` and `mixer` take the same flags. See
[Performing a narrated output](../commands.md#performing-a-narrated-output).

## Publish

```
pablo publish --project ice-house --output narrated --target script
```

Writes `.pablo/out/<slug>-narrated-script.md`: every reading's script in unit order under
`## Reading N: <title>`. `script` is the only target; the audio comes from `mix`.
