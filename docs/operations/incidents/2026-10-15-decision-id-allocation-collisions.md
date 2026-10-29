# Decision id allocation collisions

## What happened

Concurrent sessions allocated the same DEC id for different records. For example DEC-0206 was claimed by both the CodeQL default-setup decision and the AISDLC-833 security escalation that docs and workflows cite as DEC-0206. A planner session also opened the D16 record twice, as DEC-0249 and DEC-0250.

## Impact

Citations pointed at the wrong record. The colliding records had to be renumbered and cross-references checked by hand.

## Timeline (UTC)

- 2026-10-14: CodeQL record opened under an id already cited for AISDLC-833.
- 2026-10-15 18:40: planner renumbered the colliding records: DEC-0206 to DEC-0242, DEC-0241 to DEC-0245, DEC-0237 to DEC-0246, DEC-0233 to DEC-0243 and DEC-0244.
- 2026-10-15 22:45: D16 opened twice 40 seconds apart (DEC-0249, DEC-0250).

## Ruling and who made it

DEC-0242, DEC-0243, DEC-0244, DEC-0245, DEC-0246 (planner): renumber, keep the original chosen option. DEC-0249 records that it mirrors DEC-0250 and carries no authority.

## Root cause

Id allocation was not serialised across sessions, and there was no duplicate check on open.

## Follow-up

None filed yet; listed in the ledger as "none yet".
