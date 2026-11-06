# @lp-labs/schema-inference

Infer a descriptive schema from a bounded sample of JSON object rows. Inspect type counts, nulls, missing fields, nested object/array shapes and sample agreement before accepting an import mapping.

- Zero runtime or peer dependencies; independently authored, framework-independent.
- ESM, CommonJS and TypeScript declarations.
- Incremental accumulation with atomic rejection of invalid rows.
- Explicit quotas, no retained references to input records, independent snapshots.
- Separate user-correction plans that preserve observed evidence.

## Installation

```sh
npm install @lp-labs/schema-inference
```

Requires Node.js 18+ or a modern JavaScript browser with an ESM-aware bundler. No browser APIs, timers, storage or network calls are used.

## Quickstart

```js
import { infer, fields } from '@lp-labs/schema-inference';

const report = infer([
  { id: 1, name: 'Ada', total: 10 },
  { id: 2, name: null, total: 12.5 },
  { id: 3, total: 5 },
]);

console.log(report.schema.properties.name.missing); // 1
console.log(report.schema.properties.name.nullable); // true
console.log(report.schema.properties.total.preferred); // number

const plan = fields(report, [
  { path: '/properties/id', type: 'string', required: true },
]);
console.log(plan.find((field) => field.path === '/properties/id').type); // string
```

CommonJS: `const { infer, fields } = require('@lp-labs/schema-inference')`.

## What inference means

This is a descriptive sample report, **not a JSON Schema implementation, validator, converter or guarantee about future rows**. It does not infer dates, currencies, email addresses, IDs, numeric strings, formats, enums, referential integrity or business rules. `"123"` remains a string; `123` is an integer observation.

`required` means present in every relevant sampled object; it is not proof of a universal requirement. `nullable` means at least one explicit `null` was observed. Missing and null are counted separately.

`confidence` is the proportion of non-null observations belonging to the most frequent inferred kind, not a statistical confidence interval or calibrated probability. A one-row sample can have confidence 1. Sampling is deterministic first-N; shuffle or stratify upstream if the first records are biased.

## API

Runtime exports: `createInference`, `infer`, `fields`.

Type exports: `ObservedType`, `InferredType`, `InferenceOptions`, `StringSummary`, `NumberSummary`, `ArraySummary`, `InferredNode`, `InferenceReport`, `Inference`, `Correction`, `CorrectedField`.

### infer(rows, options?)

Consume a synchronous iterable of plain object rows. Stop after `sampleSize` without pulling an extra row; an unfinished source iterator is closed. Source errors and cleanup errors propagate.

Returns:

```ts
interface InferenceReport {
  sampledRows: number;
  sampleLimit: number;
  saturated: boolean;
  schema: InferredNode;
}
```

`saturated` means the sample reached its limit. It does **not** prove there are additional unsampled rows: the library intentionally does not pull another item to find out.

### createInference(options?)

Create an incremental accumulator:

```js
import { createInference } from '@lp-labs/schema-inference';

const inference = createInference({ sampleSize: 100, maxNodes: 50000 });
inference.add({ value: 1 });
inference.add({ value: null });
console.log(inference.snapshot().schema.properties.value.types); // ['null', 'integer']
```

- `add(row)` synchronously validates the entire row, then merges its observations. Invalid rows do not alter statistics, row count or used quotas. Adding after the sample is full throws `RangeError`.
- `snapshot()` creates a fresh report. Mutating a snapshot does not change the accumulator or other snapshots.
- No source values or object references are retained after an addition. Shared noncyclic input objects are allowed and counted at each occurrence.
- There is no reset/merge/persist API in this initial release; create a new accumulator for a new independent sample.

For async sources, await them yourself and call `add` up to your chosen limit. Check a cancellation signal in that loop if needed. The synchronous library cannot interrupt blocked source operations.

### Options and quotas

| Option | Default | Meaning |
|---|---|---|
| `sampleSize` | `1000` | Maximum accepted rows. Positive safe integer. |
| `maxDepth` | `16` | Maximum nested value depth, root row at depth zero; integer from 0 to 256. |
| `maxNodes` | `100000` | Cumulative visited values across accepted rows, including roots, nulls, arrays and each element. Positive safe integer. |
| `maxProperties` | `10000` | Cumulative object property occurrences across accepted rows. Does not count array indexes or array `length`. |
| `maxStringLength` | `10000` | Maximum UTF-16 units in an individual string value. |

All quotas are exact, not best-effort sampling cutoffs. Except `sampleSize`, overflow throws instead of quietly skipping a field or truncating a row. A failed addition does not consume any cumulative quota. Limits count values/properties, not bytes or unique schema paths.

Property-name sizes, object reflection metadata, caller-owned inputs and JavaScript engine allocation overhead are not byte-bounded. Do not treat quotas as a hardened process memory sandbox.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
