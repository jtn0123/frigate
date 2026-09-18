# Ledger rows

One file per ledger row, named `<ID>.md`, holding exactly one row of the
table in `FORK.md`:

```
| ID | Area | Files | Why | Upstream PR |
```

A new ID gets a new file here and `FORK.md` is left alone, so two pull
requests never edit the same lines (I35). To update a row that is still in
`FORK.md`'s table, edit it there. Write a literal pipe inside a cell as `\|`.

```bash
make ledger                              # the whole ledger, sorted by ID
python3 fork/scripts/ledger.py --check   # validate the row files
```

`fork/scripts/test_ledger.py` runs the same validation in `make check` and CI.
