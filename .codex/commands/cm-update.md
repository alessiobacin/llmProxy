# cm-update

Run the complete Code-Mem repository update from this project root:

`cm update --memory --deep`

This command detects the local harnesses, repairs their cm hooks and skill,
indexes documents and source files, asks the configured harness LLM for
evidence-bound semantic relations, refreshes memory projections, and writes
`memory/graph-3d.html`. Do not run the legacy scan/entity commands first.
