# Ordered tier ownership

This is the ownership foundation for [#253](https://github.com/iamaamir/pi-bifrost/issues/253), under the revised init contract in [#235](https://github.com/iamaamir/pi-bifrost/issues/235).
The action picker, explicit defaults reset, and inherited-pool review remain separate workstreams.

## Stored state

The existing ownership file now stores version 2, the configuration scope, and one record per known tier.
A generated record contains the exact ordered model list, including a generated empty list.
Bifrost can refresh that tier only when the current source list matches the record exactly.

An addition, removal, reorder, duplicate, scalar replacement, or deliberate empty list makes the whole tier user-managed.
A user record retains that decision even when a later edit deletes the tier.
A deleted record prevents routine init from recreating the tier.
Absence and an explicit empty list are different states.

Init protects user-managed tiers and refreshes unchanged generated tiers.
Config reconciliation blocks changes to user-managed tiers with `tier_protected`.
It derives the next ownership record from the complete target configuration, not only the selected tier.
Automatic first-use setup writes the same format through the existing transaction.
No second persistence mechanism is introduced.

## Migration and recovery

Version 1 records do not prove ordered whole-tier ownership.
Readers therefore treat them as unowned, rather than inferring permission from individual generated model keys.
An approved init can record existing tiers as user-managed without changing their configuration bytes.
Missing evidence never grants ownership of an existing tier.
Invalid records and records for another scope block target writes.

The transaction store continues to read valid version 1 records and pending journals.
Recovery completes or aborts the recorded transaction before any new migration.
New ownership writes use version 2.
Existing digest checks, cooperative locks, exact backups, and recovery checks remain in place.
These locks do not fence external editors atomically.

## Engineering challenge

The independent Issue Challenger inspected the original dirty draft at baseline `de3f53632e2b72a9a9e9020e7dc12f26416795fc`.
The implementation owner accepted IC-1, IC-2, IC-3, and IC-5: protect whole tiers, preserve unrelated ownership, preserve configuration bytes, and test migration recovery.
IC-4 remains with #243 and #255: early preflight and explicit inherited-pool review.
This deferral does not satisfy or waive those acceptance criteria.

The representation uses generated, user, and deleted records instead of a configuration-wide digest.
This preserves independent tier edits and deletion intent without granting ownership to legacy data.
The provider membership view remains a temporary input to the existing delta calculation, never a second stored ownership model.
